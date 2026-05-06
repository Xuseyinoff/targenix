/**
 * Read-only audit: `target_websites` rows with NO template but legacy config
 *   WHERE isActive = 1
 *     AND connectionId IS NULL
 *     AND templateId IS NULL
 *
 * Purpose: classify each row for backfill (link vs create template vs manual),
 *  detect risks, and guess affiliate/endpoint alignment — WITHOUT writes.
 *
 * Safety:
 *   - SELECT only; no mutations.
 *   - Secret values are NEVER logged in full; only masked previews / presence.
 *
 * Usage (PowerShell, repo root):
 *   railway run --service targenix.uz node tooling/mysql/audit-no-template-targets.mjs
 *   node tooling/mysql/audit-no-template-targets.mjs --json --pretty
 *   node tooling/mysql/audit-no-template-targets.mjs --only-errors
 *
 * @see stage4-backfill-no-connection.mjs  (applies when templateId is set)
 */

import "dotenv/config";
import mysql from "mysql2/promise";

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { json: false, pretty: false, onlyErrors: false };
  for (const a of argv) {
    if (a === "--json") o.json = true;
    if (a === "--pretty") o.pretty = true;
    if (a === "--only-errors" || a === "--only-issues") o.onlyErrors = true;
  }
  return o;
}

// ── DB (read-only) ──────────────────────────────────────────────────────────
function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

// ── JSON: templateConfig as returned by MySQL2 (object or string) ─────────
function safeParseConfig(raw) {
  if (raw == null) {
    return { ok: true, value: null, error: null };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, value: raw, error: null };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) {
      return { ok: true, value: null, error: null };
    }
    try {
      return { ok: true, value: JSON.parse(s), error: null };
    } catch (e) {
      return {
        ok: false,
        value: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { ok: false, value: null, error: "unsupported_type" };
}

// ── Normalization (case/filename-style) ─────────────────────────────────────
function normKey(k) {
  if (typeof k !== "string") return null;
  return k
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

const SECRET_NAME_SYNONYMS = new Map([
  ["apikey", "api_key"],
  ["api", "api_key"],
  ["access_token", "token"],
  ["authtoken", "token"],
  ["bearer", "token"],
  ["x_api_key", "api_key"],
]);

/**
 * Recursively collect string leaves from a plain object; keys normalized.
 * Stops at depth 4 to avoid runaway objects.
 */
function collectLeafSecrets(obj, out, depth = 0, prefix = "") {
  if (depth > 4 || obj == null) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        collectLeafSecrets(v, out, depth + 1, `${prefix}$${i}$`);
      }
    }
    return;
  }
  if (typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const nk = normKey(k);
    if (nk == null) continue;
    const fullKey = prefix ? `${prefix}.${nk}` : nk;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      collectLeafSecrets(v, out, depth + 1, fullKey);
    } else if (typeof v === "string") {
      out.set(fullKey, v);
    } else if (v != null && (typeof v === "number" || typeof v === "boolean")) {
      out.set(fullKey, String(v));
    }
  }
}

function collectSecretsFromMap(secrets) {
  const out = new Map();
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    return out;
  }
  collectLeafSecrets(secrets, out, 0, "");
  return out;
}

/** `{{SECRET:api_key}}` and legacy `{{VAR}}` in strings */
const RE_SECRET = /\{\{\s*SECRET:([a-zA-Z0-9_]+)\s*\}\}/g;
const RE_DUP = /\{+\s*([a-zA-Z0-9_]+)\s*}+/g;

function keysReferencedInString(s) {
  const set = new Set();
  if (typeof s !== "string" || !s) return set;
  let m;
  while ((m = RE_SECRET.exec(s)) !== null) {
    set.add(normKey(m[1]) || m[1].toLowerCase());
  }
  RE_SECRET.lastIndex = 0;
  // crude: do not add every `{{name}}` — only lines that look secret-related
  const lower = s.toLowerCase();
  if (lower.includes("secret") || lower.includes("api_key") || lower.includes("token")) {
    while ((m = RE_DUP.exec(s)) !== null) {
      const n = normKey(m[1]);
      if (n) set.add(n);
    }
  }
  return set;
}

function bodyFieldsToKeysAndRefs(bodyFields) {
  const keys = new Set();
  const refs = new Set();
  if (!Array.isArray(bodyFields)) return { keys, refs };
  for (const row of bodyFields) {
    if (!row || typeof row !== "object") continue;
    if (row.key) {
      const n = normKey(String(row.key));
      if (n) keys.add(n);
    }
    if (row.value) keysReferencedInString(String(row.value)).forEach((x) => refs.add(x));
  }
  return { keys, refs };
}

function isLikelyCiphertext(s) {
  if (typeof s !== "string" || s.length < 10) return false;
  if (!s.includes(":")) return false;
  const [iv, rest] = s.split(":", 2);
  if (!/^[0-9a-f]+$/i.test(iv) || !rest) return false;
  return rest.length > 8 && /^[0-9a-f]+$/i.test(rest);
}

/**
 * Masks a string for logs — never the full value.
 * Ciphertext: show iv prefix + "…" + last 4 hex
 * Other:       show first/last 2-4 with ellipsis
 */
function maskValue(s) {
  if (s == null) return "∅";
  if (typeof s !== "string") return String(s).length > 0 ? "«non-string»" : "∅";
  if (s.length === 0) return "∅";
  if (isLikelyCiphertext(s)) {
    const [a, b] = s.split(":", 2);
    if (!b) return `${a.slice(0, 8)}…(cipher)`;
    return `${a.slice(0, 8)}…${b.slice(-4)}(cipher)`;
  }
  if (s.length <= 6) return `•••${s.length}ch`;
  return `${s.slice(0, 2)}…${s.slice(-2)}(${s.length}ch)`;
}

// ── Heuristic: structural similarity to a destination_template row ────────
function parseJsonArrayDb(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return [];
}

function templateBodyFieldKeys(tpl) {
  const bf = parseJsonArrayDb(tpl.bodyFields);
  const keys = new Set();
  for (const row of bf) {
    if (row?.key) {
      const n = normKey(String(row.key));
      if (n) keys.add(n);
    }
  }
  return keys;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  return inter / (a.size + b.size - inter);
}

function hostOf(urlStr) {
  if (typeof urlStr !== "string" || !urlStr.trim()) return null;
  try {
    const u = new URL(
      urlStr.startsWith("http") ? urlStr : `https://${urlStr.trim()}`,
    );
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @returns {Array<{id:number, host:string, pathHint:string, score:number, reasons:string[]}>}
 */
function scoreTemplatesAgainstTarget(urlStr, config, templates) {
  const h = hostOf(urlStr);
  const path = (() => {
    try {
      const u = new URL(
        urlStr.startsWith("http") ? urlStr : `https://${String(urlStr).trim()}`,
      );
      return u.pathname;
    } catch {
      return "";
    }
  })();
  const { keys: targetBfKeys } = bodyFieldsToKeysAndRefs(
    config?.bodyFields,
  );
  const secKeys = Array.from(
    collectSecretsFromMap(config?.secrets ?? {}).keys(),
  ).map((k) => k.split(".").pop() || k);

  const out = [];
  for (const tpl of templates) {
    let score = 0;
    const reasons = [];
    const ep = tpl.endpointUrl;
    const th = hostOf(ep);
    if (h && th) {
      if (h === th) {
        score += 45;
        reasons.push("host:exact");
      } else if (h.endsWith(`.${th}`) || th.endsWith(`.${h}`)) {
        score += 35;
        reasons.push("host:subdomain_match");
      } else if (h.includes(th) || th.includes(h)) {
        score += 25;
        reasons.push("host:partial");
      } else {
        // shared path segments (e.g. /api/shop/)
        const pathSegs = new Set(
          path.split("/").filter((x) => x && x.length > 2),
        );
        const epath = (() => {
          try {
            return new URL(
              String(ep).startsWith("http")
                ? String(ep)
                : `https://${String(ep).trim()}`,
            ).pathname;
          } catch {
            return "";
          }
        })();
        const tSegs = new Set(
          epath.split("/").filter((x) => x && x.length > 2),
        );
        for (const s of pathSegs) {
          if (tSegs.has(s)) {
            score += 12;
            reasons.push(`path_seg:${s}`);
            break;
          }
        }
      }
    }
    const tplKeys = templateBodyFieldKeys(tpl);
    if (targetBfKeys.size > 0 && tplKeys.size > 0) {
      const j = jaccard(targetBfKeys, tplKeys);
      score += Math.round(25 * j);
      if (j > 0.3) {
        reasons.push(`bodyFields_jaccard:${(j * 100).toFixed(0)}%`);
      }
    }
    // userVisibleFields alignment with available secret key names
    const uvf = parseJsonArrayDb(tpl.userVisibleFields);
    const uKeys = new Set(
      (Array.isArray(uvf) ? uvf : [])
        .map((x) => normKey(String(x)))
        .filter(Boolean),
    );
    const sSet = new Set(secKeys);
    for (const uk of uKeys) {
      const syn = SECRET_NAME_SYNONYMS.get(uk) || uk;
      for (const sk of sSet) {
        const ssk = sk.split(".").pop() || sk;
        if (ssk === uk || ssk === syn) {
          score += 15;
          reasons.push(`uvf_secret:${uk}`);
        }
      }
    }
    out.push({ id: tpl.id, name: tpl.name, appKey: tpl.appKey, host: th, pathHint: path, score, reasons, endpointUrl: tpl.endpointUrl });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Risk + recommendation ───────────────────────────────────────────────────
const ACTION = {
  LINK: "LINK_EXISTING_TEMPLATE",
  CREATE: "CREATE_TEMPLATE",
  MANUAL: "MANUAL_REVIEW",
};

function classifyApiLikePresence(mergedKeyMap) {
  const all = new Set();
  for (const k of mergedKeyMap.keys()) {
    const leaf = k.split(".").pop() || k;
    let nk = normKey(leaf) || "";
    if (SECRET_NAME_SYNONYMS.has(nk)) nk = SECRET_NAME_SYNONYMS.get(nk) || nk;
    all.add(nk);
  }
  const hasApi =
    all.has("api_key") || Array.from(all).some((k) => k.includes("api_key"));
  const hasOffer = all.has("offer_id");
  const hasToken = all.has("token") || Array.from(all).some((k) => k === "access_token" || k.endsWith("_token"));
  return { hasApi, hasOffer, hasToken, keySet: all };
}

function buildRisks({
  parseOk,
  config,
  secretMap,
  bodyRefs,
  url,
}) {
  const risks = [];
  const add = (code, severity, detail) => risks.push({ code, severity, detail });

  if (!parseOk) {
    add("INVALID_JSON", "high", "templateConfig is not valid JSON / object");
    return risks;
  }
  if (!url || !String(url).trim()) {
    add("EMPTY_URL", "high", "no target url — cannot match affiliate endpoint");
  }
  if (!config || typeof config !== "object") {
    add("EMPTY_CONFIG", "high", "templateConfig is empty");
    return risks;
  }
  if (!config.method) {
    add("MISSING_METHOD", "low", "HTTP method not set in config (may still default at send time)");
  }
  const { hasApi, hasToken } = classifyApiLikePresence(secretMap);
  if (secretMap.size === 0) {
    add("NO_SECRETS_OBJECT", "medium", "no `secrets` map or empty");
  }
  if (!hasApi && !hasToken) {
    add("NO_API_LIKE_SECRET", "high", "no api_key- or token-like key under secrets (after normalization / nesting)");
  }
  for (const [k, v] of secretMap) {
    if (typeof v === "string" && v.trim() === "") {
      add("EMPTY_SECRET_VALUE", "high", { key: k, detail: "empty string" });
    }
  }
  // Plaintext in bodyTemplate (not necessarily secret — but suspicious if long alnum without SECRET:)
  const bt = config.bodyTemplate;
  if (typeof bt === "string" && bt.length > 200) {
    if (!bt.includes("{{SECRET:") && /[A-Za-z0-9+/]{32,}/.test(bt)) {
      add("SUSPICIOUS_BODY_PLAINTEXT", "medium", "long alnum-like run in bodyTemplate without {{SECRET:}} (possible pasted secret)");
    }
  }
  // Referenced in bodyFields but not present
  const apiLike = classifyApiLikePresence(secretMap);
  for (const ref of bodyRefs) {
    if (apiLike.keySet.has(ref) || normKey(ref) === "name" || normKey(ref) === "stream") {
      continue;
    }
    const inSecrets = [...secretMap.keys()].some(
      (k) => (k.split(".").pop() || k) === ref || (k.split(".").pop() || k) === normKey(ref),
    );
    if (!inSecrets) {
      add("BODY_REF_MISSING_IN_SECRETS", "medium", { ref });
    }
  }
  return risks;
}

function pickRecommended({
  bestScore,
  bestTpl,
  hasApiLike,
  parseOk,
  highRisks,
}) {
  if (!parseOk) {
    return { action: ACTION.MANUAL, confidence: 0, rationale: "Fix JSON or export row manually." };
  }
  if (highRisks > 0 && (bestScore < 30 || !bestTpl)) {
    return {
      action: ACTION.MANUAL,
      confidence: Math.min(40, 15 + (bestScore || 0) / 3),
      rationale:
        "High-severity config issues with weak/no template match — fix risks first, then re-audit.",
    };
  }
  if (bestTpl && bestScore >= 70 && hasApiLike) {
    return {
      action: ACTION.LINK,
      confidence: Math.min(100, bestScore + (hasApiLike ? 5 : 0)),
      rationale: `Strong match to template id=${bestTpl.id} (${bestTpl.appKey}): set templateId, then run Stage 4 backfill to link connection.`,
    };
  }
  if (bestTpl && bestScore >= 45 && hasApiLike) {
    return {
      action: ACTION.LINK,
      confidence: Math.min(90, bestScore + 5),
      rationale: `Possible match to template id=${bestTpl.id}; compare endpoint and body in admin, then set templateId.`,
    };
  }
  if (hasApiLike) {
    return {
      action: ACTION.CREATE,
      confidence: Math.min(60, 25 + (bestScore || 0) / 2),
      rationale:
        "Secrets look present but no strong `destination_templates` match — add or clone a template, or map URL manually in admin UI.",
    };
  }
  return {
    action: ACTION.MANUAL,
    confidence: Math.max(0, Math.round((bestScore || 0) * 0.4)),
    rationale: "Missing api-like credentials or high ambiguity; manual review before migration.",
  };
}

function rowNeedsAttention(row) {
  if (row.recommendedAction === ACTION.MANUAL) return true;
  if (row.aggregateSeverity === "high") return true;
  if (row.risks.some((r) => r.severity === "high")) return true;
  return false;
}

// ── Main query ────────────────────────────────────────────────────────────
async function run() {
  const args = parseArgs(process.argv.slice(2));
  const url = getMysqlUrl();
  if (!url) {
    console.error("[audit-no-template] No MYSQL url in env (MYSQL_PUBLIC_URL, MYSQL_URL, DATABASE_URL).");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  const results = [];
  try {
    const [templates] = await conn.query(
      `SELECT id, name, appKey, endpointUrl, bodyFields, userVisibleFields, variableFields, isActive
         FROM destination_templates
        WHERE isActive = 1
        ORDER BY id ASC`,
    );
    const [rows] = await conn.query(
      `SELECT id, userId, name, url, templateConfig
         FROM target_websites
        WHERE isActive = 1
          AND connectionId IS NULL
          AND templateId IS NULL
        ORDER BY id ASC`,
    );
    for (const r of rows) {
      const parsed = safeParseConfig(r.templateConfig);
      const config = parsed.ok ? parsed.value : null;
      const smap = new Map();
      if (config?.secrets && typeof config.secrets === "object") {
        collectLeafSecrets(config.secrets, smap, 0, "secrets");
      }
      // merge top-level legacy keys
      for (const legacy of ["apiKeyEncrypted", "botTokenEncrypted"]) {
        if (config && config[legacy] && typeof config[legacy] === "string") {
          const nk = normKey(legacy.replace(/Encrypted$/i, "")) || legacy;
          smap.set(`legacy.${nk}`, String(config[legacy]));
        }
      }
      const { refs: bodyRefs } = bodyFieldsToKeysAndRefs(
        config?.bodyFields,
      );
      if (config?.bodyTemplate) {
        keysReferencedInString(String(config.bodyTemplate)).forEach((x) =>
          bodyRefs.add(x),
        );
      }
      const highRisks = buildRisks({
        parseOk: parsed.ok,
        config,
        secretMap: smap,
        bodyRefs,
        url: r.url,
      });
      const scored = scoreTemplatesAgainstTarget(
        r.url,
        config || {},
        templates,
      );
      const best = scored[0];
      const { hasApi } = classifyApiLikePresence(smap);
      const highCount = highRisks.filter((x) => x.severity === "high").length;
      const { action, confidence, rationale } = pickRecommended({
        bestScore: best?.score ?? 0,
        bestTpl: best
          ? { id: best.id, name: best.name, appKey: best.appKey }
          : null,
        hasApiLike: hasApi,
        parseOk: parsed.ok,
        highRisks: highCount,
      });
      const aggregateSeverity = highRisks.some((x) => x.severity === "high")
        ? "high"
        : highRisks.some((x) => x.severity === "medium")
          ? "medium"
          : "low";

      const masked = {};
      for (const [k, v] of smap) {
        masked[k] = maskValue(v);
      }

      const outRow = {
        id: r.id,
        userId: r.userId,
        name: r.name,
        url: r.url,
        parseOk: parsed.ok,
        parseError: parsed.error,
        method: config?.method ?? null,
        contentType: config?.contentType ?? null,
        secretKeysDetected: Array.from(
          new Set([...smap.keys()].map((k) => k.replace(/^secrets\./, ""))),
        ),
        maskedSecretPreviews: masked,
        bodyFieldRefs: Array.from(bodyRefs).sort(),
        affiliate: {
          bestTemplateId: best?.id ?? null,
          bestTemplateName: best?.name ?? null,
          bestAppKey: best?.appKey ?? null,
          /** 0–100: structural+URL+field alignment to best template (not a probability). */
          matchScore: Math.min(100, best?.score ?? 0),
          matchReasons: best?.reasons ?? [],
          scoreBreakdown: best
            ? { score: best.score, reasons: best.reasons }
            : null,
          alternatives: scored.slice(1, 4).map((s) => ({
            id: s.id,
            name: s.name,
            appKey: s.appKey,
            score: s.score,
          })),
        },
        risks: highRisks,
        aggregateSeverity,
        recommendedAction: action,
        recommendationConfidence: Math.round(confidence),
        recommendationRationale: rationale,
      };
      results.push(outRow);
    }

    // ── Output ──
    const filtered = args.onlyErrors
      ? results.filter(rowNeedsAttention)
      : results;

    if (args.json) {
      const payload = {
        generatedAt: new Date().toISOString(),
        mode: "read_only",
        totalRows: results.length,
        afterFilter: filtered.length,
        onlyErrors: args.onlyErrors,
        rows: filtered,
      };
      const s = args.pretty
        ? JSON.stringify(payload, null, 2)
        : JSON.stringify(payload);
      process.stdout.write(s + "\n");
    } else {
      console.log("\n" + "═".repeat(72));
      console.log("  NO-TEMPLATE target_websites audit (read-only)");
      console.log("  Filter: isActive=1, connectionId NULL, templateId NULL");
      console.log("═".repeat(72));
      console.log(`  Rows: ${results.length}  (showing ${filtered.length} after --only-errors filter)\n`);
      for (const row of filtered) {
        console.log("─".repeat(72));
        console.log(
          `  id=${row.id}  userId=${row.userId}  name=${row.name || "—"}`,
        );
        console.log(`  url: ${row.url || "—"}`);
        console.log(
          `  parseOk=${row.parseOk}  method=${row.method ?? "—"}  contentType=${row.contentType ?? "—"}`,
        );
        if (!row.parseOk) console.log(`  parseError: ${row.parseError}`);
        console.log(
          `  secret keys (incl. nested): ${row.secretKeysDetected.length ? row.secretKeysDetected.join(", ") : "—"}`,
        );
        console.log("  masked previews: " + JSON.stringify(row.maskedSecretPreviews));
        if (row.bodyFieldRefs.length) {
          console.log("  bodyField SECRET/refs: " + row.bodyFieldRefs.join(", "));
        }
        console.log(
          `  affiliate: best template ${row.affiliate.bestTemplateId ?? "—"} (${row.affiliate.bestAppKey ?? "—"})  matchScore ${row.affiliate.matchScore}  reasons: ${(row.affiliate.matchReasons || []).join(" | ") || "—"}`,
        );
        if (row.affiliate.alternatives.length) {
          console.log(
            "    alt: " +
              row.affiliate.alternatives
                .map((a) => `id=${a.id} sc=${a.score}`)
                .join(" ; "),
          );
        }
        console.log(`  risks (${row.aggregateSeverity}):`);
        for (const rk of row.risks) {
          console.log(
            `    - [${rk.severity}] ${rk.code} ${typeof rk.detail === "object" ? JSON.stringify(rk.detail) : rk.detail || ""}`,
          );
        }
        console.log(
          `  → action: ${row.recommendedAction}  (conf ${row.recommendationConfidence}%)  ${row.recommendationRationale}`,
        );
      }
      console.log("─".repeat(72) + "\n");
    }
  } finally {
    await conn.end();
  }
}

run().catch((e) => {
  console.error("[audit-no-template] FATAL", e);
  process.exit(1);
});

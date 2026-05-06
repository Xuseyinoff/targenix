/**
 * Stage 4 — SAFE backfill: create `connections` rows for `target_websites`
 * that have encrypted secrets in `templateConfig` but `connectionId` IS NULL,
 * then link `target_websites.connectionId`.
 *
 * Schema truth:
 *   • connectionId lives on `target_websites`, NOT on `integration_destinations`.
 *   • api_key rows match `insertApiKeyConnection` / connectionsRouter:
 *       credentialsJson = { templateId, secretsEncrypted: { key: ciphertext, ... } }
 *     (ciphertext is COPIED from `templateConfig.secrets` — no re-encrypt,
 *     same as historical createFromConnection copy behaviour.)
 *   • `appKey` is taken from `destination_templates.appKey` (e.g. sotuvchi),
 *     never the literal "api_key".
 *
 * Modes (exactly one primary action):
 *   --backup   Write backup_stage4_no_connection.json and exit.
 *   --dry-run  Read-only: classify rows, log counts + details. No writes.
 *   --apply    Create / reuse connections + link (requires guards below).
 *   --rollback --report=stage4-apply-report.json
 *              NULL target_websites.connectionId, DELETE created connections.
 *
 * Guards (apply / rollback on prod):
 *   RAILWAY_PROJECT_ID must be set.
 *   ENCRYPTION_KEY length must be 32.
 *   --expected-key-hash must match sha256(ENCRYPTION_KEY) (proves you run in prod context).
 *   --confirm=STAGE4_APPLY  (apply only)
 *
 * De-dupe: if an api_key connection already exists for the same user with the
 * same `templateId` in credentialsJson and identical `secretsEncrypted` map,
 * re-use its id (no new INSERT).
 *
 * Usage (PowerShell, from repo root):
 *   railway run --service targenix.uz node tooling/mysql/stage4-backfill-no-connection.mjs --backup
 *   railway run --service targenix.uz node tooling/mysql/stage4-backfill-no-connection.mjs --dry-run --expected-key-hash=<hash>
 *   railway run --service targenix.uz node tooling/mysql/stage4-backfill-no-connection.mjs --apply --expected-key-hash=<hash> --confirm=STAGE4_APPLY
 *
 * Get hash (same as Stage D / Stage 3):
 *   railway run --service targenix.uz node tooling/mysql/_print-key-hash.mjs
 */

import crypto from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BACKUP_FILE = join(REPO_ROOT, "backup_stage4_no_connection.json");
const DEFAULT_REPORT = join(__dirname, "stage4-apply-report.json");

// ── Mirror server/encryption.ts (verify only; apply copies ciphertext) ─────
function getAesKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY missing");
  return crypto.createHash("sha256").update(raw).digest();
}
function tryDecryptCiphertext(ciphertext) {
  if (typeof ciphertext !== "string" || !ciphertext.includes(":")) {
    return { ok: false, error: "not_ciphertext" };
  }
  try {
    const [ivHex, encHex] = ciphertext.split(":");
    if (!ivHex || !encHex) return { ok: false, error: "bad_format" };
    const iv = Buffer.from(ivHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", getAesKey(), iv);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return { ok: true, plaintext: out.toString("utf8") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

function parseArgs(argv) {
  const out = {
    backup: false,
    dryRun: false,
    apply: false,
    rollback: false,
    reportPath: null,
    expectedKeyHash: null,
    confirm: null,
  };
  for (const a of argv) {
    if (a === "--backup") out.backup = true;
    if (a === "--dry-run") out.dryRun = true;
    if (a === "--apply") out.apply = true;
    if (a === "--rollback") out.rollback = true;
    if (a.startsWith("--report=")) out.reportPath = a.slice("--report=".length);
    if (a.startsWith("--expected-key-hash=")) {
      out.expectedKeyHash = a.slice("--expected-key-hash=".length);
    }
    if (a.startsWith("--confirm=")) out.confirm = a.slice("--confirm=".length);
  }
  if (!out.reportPath && (out.rollback || out.apply)) {
    // apply writes here by default; rollback uses same path if not set
  }
  return out;
}

function abort(msg) {
  console.error(`[stage4-backfill] ABORT: ${msg}`);
  process.exit(1);
}

function assertProdGuards(applyOrRollback) {
  if (applyOrRollback) {
    if (!process.env.RAILWAY_PROJECT_ID) {
      abort(
        "RAILWAY_PROJECT_ID not set — apply/rollback must run via `railway run` on prod.",
      );
    }
  }
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) abort("ENCRYPTION_KEY not set");
  if (raw.length !== 32) {
    abort(`ENCRYPTION_KEY length is ${raw.length}; must be 32 bytes.`);
  }
}

function keyHash() {
  return crypto
    .createHash("sha256")
    .update(process.env.ENCRYPTION_KEY)
    .digest("hex");
}

function safeJson(x) {
  if (x == null) return null;
  if (typeof x === "string") {
    try {
      return JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (typeof x === "object") return x;
  return null;
}

/**
 * @returns {Promise<Array<{id:number,userId:number,templateId:number|null,templateConfig:object,name:string}>>}
 */
async function fetchCandidates(conn) {
  const [rows] = await conn.query(
    `SELECT id, userId, templateId, templateConfig, name
       FROM target_websites
      WHERE isActive = 1
        AND connectionId IS NULL`,
  );
  return rows;
}

/**
 * @returns {Promise<null|{id:number, name:string, appKey:string|null, userVisibleFields:string[], isActive:number}>}
 */
async function loadTemplate(conn, templateId) {
  if (templateId == null) return null;
  const [rows] = await conn.query(
    `SELECT id, name, appKey, userVisibleFields, isActive
       FROM destination_templates
      WHERE id = ? LIMIT 1`,
    [templateId],
  );
  const r = rows[0];
  if (!r) return null;
  const fields = Array.isArray(r.userVisibleFields)
    ? r.userVisibleFields
    : typeof r.userVisibleFields === "string"
      ? (() => {
          try {
            return JSON.parse(r.userVisibleFields);
          } catch {
            return [];
          }
        })()
      : [];
  return {
    id: r.id,
    name: r.name,
    appKey: r.appKey ?? null,
    userVisibleFields: fields,
    isActive: r.isActive,
  };
}

function secretsMapLooksUsable(secrets, userVisibleFields) {
  if (!userVisibleFields.length) {
    // Fall back: at least one entry under 'api_key' if present (legacy)
    if (secrets && typeof secrets === "object" && secrets.api_key) {
      return { ok: true, effectiveKeys: ["api_key"] };
    }
    return { ok: false, code: "NO_VISIBLE_KEYS", detail: "template has empty userVisibleFields" };
  }
  const miss = userVisibleFields.filter(
    (k) => !secrets || typeof secrets[k] !== "string" || !secrets[k].length,
  );
  if (miss.length) {
    return {
      ok: false,
      code: "MISSING_SECRET_KEY",
      detail: { missing: miss },
    };
  }
  return { ok: true, effectiveKeys: userVisibleFields };
}

function mapsEqual(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Find existing connection id to reuse, or null.
 */
async function findReusableConnection(conn, userId, templateId, secretsEncrypted) {
  const [rows] = await conn.query(
    `SELECT id, credentialsJson
       FROM connections
      WHERE userId = ?
        AND type = 'api_key'
        AND status = 'active'`,
    [userId],
  );
  for (const row of rows) {
    const cj = safeJson(row.credentialsJson);
    if (!cj || cj.templateId !== templateId) continue;
    const se = cj.secretsEncrypted;
    if (se && mapsEqual(se, secretsEncrypted)) {
      return row.id;
    }
  }
  return null;
}

async function runBackup() {
  const url = getMysqlUrl();
  if (!url) abort("MYSQL url missing");
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [rows] = await conn.query(
      `SELECT id, userId, templateId, templateConfig, name, url
         FROM target_websites
        WHERE isActive = 1
          AND connectionId IS NULL
        ORDER BY id ASC`,
    );
    const payload = {
      generatedAt: new Date().toISOString(),
      table: "target_websites",
      filter: "isActive=1 AND connectionId IS NULL",
      rowCount: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        templateId: r.templateId,
        name: r.name,
        url: r.url,
        templateConfig: r.templateConfig,
      })),
    };
    await writeFile(BACKUP_FILE, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[stage4-backfill] BACKUP written: ${BACKUP_FILE}`);
    console.log(`[stage4-backfill]   rows: ${rows.length}`);
  } finally {
    await conn.end();
  }
}

function classifyRow(tw, tpl) {
  const cfg = safeJson(tw.templateConfig) ?? {};
  const secrets = cfg.secrets;
  if (tw.templateId == null) {
    return { status: "SKIP", code: "NO_TEMPLATE", twId: tw.id };
  }
  if (!tpl) {
    return { status: "SKIP", code: "TEMPLATE_NOT_FOUND", twId: tw.id, templateId: tw.templateId };
  }
  if (!tpl.isActive) {
    return { status: "SKIP", code: "TEMPLATE_INACTIVE", twId: tw.id };
  }
  if (!tpl.appKey) {
    return { status: "SKIP", code: "TEMPLATE_NO_APPKEY", twId: tw.id, templateId: tpl.id };
  }
  if (!secrets || typeof secrets !== "object" || Object.keys(secrets).length === 0) {
    return { status: "SKIP", code: "EMPTY_SECRETS", twId: tw.id };
  }

  const keyCheck = secretsMapLooksUsable(secrets, tpl.userVisibleFields);
  if (!keyCheck.ok) {
    return {
      status: "SKIP",
      code: keyCheck.code,
      twId: tw.id,
      detail: keyCheck.detail,
    };
  }
  const effectiveKeys = keyCheck.effectiveKeys;
  const secretsEncrypted = {};
  for (const k of effectiveKeys) {
    const v = secrets[k];
    secretsEncrypted[k] = v;
    const d = tryDecryptCiphertext(v);
    if (!d.ok) {
      return {
        status: "SKIP",
        code: "SECRET_DECRYPT_FAIL",
        twId: tw.id,
        key: k,
        error: d.error,
      };
    }
  }

  return {
    status: "READY",
    twId: tw.id,
    userId: tw.userId,
    templateId: tpl.id,
    appKey: tpl.appKey,
    displayName: `${tpl.name} (backfill tw=${tw.id})`,
    secretsEncrypted,
  };
}

async function runDryRun(expectedHash) {
  if (expectedHash && expectedHash !== keyHash()) {
    console.error(`[stage4-backfill] KEY_HASH live     = ${keyHash()}`);
    console.error(`[stage4-backfill] KEY_HASH expected = ${expectedHash}`);
    abort("ENCRYPTION_KEY hash mismatch.");
  }
  const url = getMysqlUrl();
  if (!url) abort("MYSQL url missing");
  const conn = await mysql.createConnection({ uri: url });
  try {
    const candidates = await fetchCandidates(conn);
    const summary = { total: 0, skip: 0, ready: 0, byCode: {} };
    const details = { skip: [], ready: [] };
    for (const tw of candidates) {
      summary.total += 1;
      const tpl = await loadTemplate(conn, tw.templateId);
      const c = classifyRow(
        { ...tw, templateConfig: tw.templateConfig },
        tpl,
      );
      if (c.status === "SKIP") {
        summary.skip += 1;
        summary.byCode[c.code] = (summary.byCode[c.code] || 0) + 1;
        details.skip.push(c);
        continue;
      }
      if (c.status === "READY") {
        const reuse = await findReusableConnection(
          conn,
          c.userId,
          c.templateId,
          c.secretsEncrypted,
        );
        const action = reuse != null ? "REUSE" : "CREATE";
        summary.ready += 1;
        details.ready.push({ ...c, action, reuseId: reuse });
      }
    }
    console.log("─".repeat(72));
    console.log("  STAGE 4 backfill — DRY-RUN (no writes)");
    console.log("─".repeat(72));
    console.log(`  Scanned (connectionId NULL, active): ${candidates.length}`);
    console.log(`  READY to link (create or reuse):      ${summary.ready}`);
    console.log(`  SKIPPED:                               ${summary.skip}`);
    console.log("  Skip breakdown (code → count):");
    for (const [k, v] of Object.entries(summary.byCode).sort()) {
      console.log(`    ${k.padEnd(24)} ${v}`);
    }
    console.log("─".repeat(72));
    console.log("  READY details:");
    for (const r of details.ready) {
      console.log(
        `    tw=${r.twId} user=${r.userId} template=${r.templateId} appKey=${r.appKey} ` +
          `${r.action}${r.reuseId != null ? ` → conn=${r.reuseId}` : ""}`,
      );
    }
    if (details.skip.length) {
      console.log("  SKIPPED first lines (up to 30):");
      for (const s of details.skip.slice(0, 30)) {
        console.log(`    tw=${s.twId} code=${s.code} ${s.detail != null ? JSON.stringify(s.detail) : ""}`);
      }
      if (details.skip.length > 30) {
        console.log(`    ... +${details.skip.length - 30} more`);
      }
    }
    console.log("─".repeat(72));
    console.log("  DRY-RUN complete — no database writes.");
  } finally {
    await conn.end();
  }
}

async function runApply(expectedHash, confirm) {
  if (confirm !== "STAGE4_APPLY") {
    abort('Apply requires --confirm=STAGE4_APPLY (exact string, safety gate).');
  }
  if (!expectedHash) {
    abort("Apply requires --expected-key-hash=<sha256 of ENCRYPTION_KEY>");
  }
  if (expectedHash !== keyHash()) {
    console.error(`[stage4-backfill] KEY_HASH live     = ${keyHash()}`);
    console.error(`[stage4-backfill] KEY_HASH expected = ${expectedHash}`);
    abort("ENCRYPTION_KEY hash mismatch.");
  }
  assertProdGuards(true);
  const backfillStartIso = new Date().toISOString();
  const url = getMysqlUrl();
  if (!url) abort("MYSQL url missing");
  const conn = await mysql.createConnection({ uri: url });
  const report = {
    backfillStartIso,
    keyHash: keyHash().slice(0, 12) + "…",
    actions: [],
  };
  try {
    const candidates = await fetchCandidates(conn);
    let created = 0;
    let linked = 0;
    let reused = 0;
    for (const tw of candidates) {
      const tpl = await loadTemplate(conn, tw.templateId);
      const c = classifyRow(tw, tpl);
      if (c.status !== "READY") continue;

      const reuse = await findReusableConnection(
        conn,
        c.userId,
        c.templateId,
        c.secretsEncrypted,
      );
      const connectionId = reuse != null ? reuse : null;
      if (connectionId == null) {
        const credsJson = JSON.stringify({
          templateId: c.templateId,
          secretsEncrypted: c.secretsEncrypted,
        });
        const [resIns] = await conn.query(
          `INSERT INTO connections
            (userId, type, appKey, displayName, status, credentialsJson, lastVerifiedAt, createdAt, updatedAt)
           VALUES (?, 'api_key', ?, ?, 'active', ?, NOW(), NOW(), NOW())`,
          [c.userId, c.appKey, c.displayName, credsJson],
        );
        const newId = resIns.insertId;
        created += 1;
        report.actions.push({
          type: "INSERT_CONNECTION",
          targetWebsiteId: c.twId,
          connectionId: newId,
          userId: c.userId,
        });
        const [u] = await conn.query(
          `UPDATE target_websites SET connectionId = ? WHERE id = ? AND connectionId IS NULL`,
          [newId, c.twId],
        );
        if (u.affectedRows === 1) linked += 1;
      } else {
        reused += 1;
        report.actions.push({
          type: "REUSE_CONNECTION",
          targetWebsiteId: c.twId,
          connectionId: connectionId,
          userId: c.userId,
        });
        const [u] = await conn.query(
          `UPDATE target_websites SET connectionId = ? WHERE id = ? AND connectionId IS NULL`,
          [connectionId, c.twId],
        );
        if (u.affectedRows === 1) linked += 1;
      }
    }
    const reportPath = DEFAULT_REPORT;
    report.summary = { created, reused, linked, backfillStartIso };
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    const [nullRows] = await conn.query(`
      SELECT COUNT(*) AS n
        FROM target_websites
       WHERE isActive = 1
         AND connectionId IS NULL
    `);
    const remainingNull = nullRows[0]?.n ?? 0;
    console.log(`[stage4-backfill] APPLY done. report → ${reportPath}`);
    console.log(
      JSON.stringify(
        { created, reused, linked, backfillStartIso, remainingNullConnectionIdActive: remainingNull },
        null,
        2,
      ),
    );
  } finally {
    await conn.end();
  }
}

async function runRollback(reportPath) {
  assertProdGuards(true);
  if (!reportPath) abort("rollback requires --report= path to apply report JSON");
  const raw = await readFile(reportPath, "utf8");
  const rep = JSON.parse(raw);
  const url = getMysqlUrl();
  if (!url) abort("MYSQL url missing");
  const conn = await mysql.createConnection({ uri: url });
  try {
    const twIds = rep.actions.map((a) => a.targetWebsiteId);
    const connIds = [
      ...new Set(
        rep.actions
          .filter((a) => a.type === "INSERT_CONNECTION")
          .map((a) => a.connectionId),
      ),
    ];
    if (twIds.length) {
      const placeholders = twIds.map(() => "?").join(",");
      const [r1] = await conn.query(
        `UPDATE target_websites SET connectionId = NULL WHERE id IN (${placeholders})`,
        twIds,
      );
      console.log(`[stage4-backfill] ROLLBACK: nulled target_websites rows: ${r1.affectedRows}`);
    }
    if (connIds.length) {
      const ph = connIds.map(() => "?").join(",");
      const [r2] = await conn.query(
        `DELETE FROM connections WHERE id IN (${ph}) AND type = 'api_key'`,
        connIds,
      );
      console.log(
        `[stage4-backfill] ROLLBACK: deleted connections (inserted in apply): ${r2.affectedRows}`,
      );
    }
    console.log(
      "[stage4-backfill] ROLLBACK done. Re-run dry-run. REUSED connections were not deleted.",
    );
  } finally {
    await conn.end();
  }
}

// ── main ───────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const modes = [args.backup, args.dryRun, args.apply, args.rollback].filter(
  Boolean,
).length;
if (modes !== 1) {
  abort(
    "Pass exactly one of: --backup | --dry-run | --apply | --rollback (see file header).",
  );
}

if (args.backup) {
  // Only needs MySQL — no ENCRYPTION_KEY required for a plain row dump.
  await runBackup();
  process.exit(0);
}

if (args.dryRun) {
  assertProdGuards(false);
  await runDryRun(args.expectedKeyHash || null);
  process.exit(0);
}

if (args.apply) {
  await runApply(args.expectedKeyHash, args.confirm);
  process.exit(0);
}

if (args.rollback) {
  const rp = args.reportPath || DEFAULT_REPORT;
  await runRollback(rp);
  process.exit(0);
}

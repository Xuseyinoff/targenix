/**
 * Stage D v3 — SAFE ENCRYPTION MIGRATION for plain-text api_key values
 * stored in target_websites.templateConfig.bodyFields[] / headers.
 *
 * Why this script looks paranoid:
 *   Stage D v1 encrypted data with the LOCAL `.env` ENCRYPTION_KEY while
 *   production used a DIFFERENT key. Decrypt failed silently (empty
 *   api_key was sent on the wire), 4 Sotuvchi orders were lost and the
 *   migration was rolled back after 9 minutes. Every guard below exists
 *   to make that specific failure impossible to reproduce.
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ MUST be invoked as:                                        │
 *   │   railway run --service targenix.uz node                   │
 *   │     tooling/mysql/stage-d-v3-migrate.mjs                   │
 *   │     --expected-key-hash=<prod-hash>                        │
 *   │     [--dry-run | --apply]                                  │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Hard guards (any violation → immediate abort, no DB access):
 *   • NO `import "dotenv/config"` anywhere in this file. Local `.env`
 *     MUST NOT shadow Railway-injected variables.
 *   • `RAILWAY_PROJECT_ID` must be set — proves we are inside a
 *     `railway run` context, not a bare local `node` invocation.
 *   • `--expected-key-hash` must match `sha256(ENCRYPTION_KEY)` —
 *     operator-level confirmation that the key loaded matches the
 *     running production runtime. Fetch the expected hash with:
 *       railway run --service targenix.uz node -e "console.log(
 *         require('crypto').createHash('sha256')
 *           .update(process.env.ENCRYPTION_KEY).digest('hex'))"
 *   • Must pass exactly one of `--dry-run` or `--apply`.
 *
 * Safety pattern (`--apply`):
 *   1. Collect all candidates in a single SELECT.
 *   2. Write backup_api_keys_stageD_v3.json (chmod 0600) BEFORE any
 *      write. This file is gitignored (backup_*.json).
 *   3. Open a MySQL transaction. For each candidate:
 *        encrypt → UPDATE → re-SELECT → decrypt → compare to original.
 *        Any mismatch aborts the loop and triggers a full ROLLBACK.
 *   4. COMMIT only after every row passes the round-trip check.
 *   5. Leave the backup file on disk — the rollback script
 *      (stage-d-v3-rollback.mjs) uses it to reverse the migration at
 *      any future point.
 *
 * Scope: ONLY fields with `key === "api_key"` in `templateConfig.bodyFields`
 *   OR keys matching /^(api[_-]?key|authorization)$/i in `templateConfig.headers`,
 *   and only when the value is a plain non-empty string that does NOT
 *   already contain `{{SECRET:…}}`. Any other field is left untouched.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

// ─── Hard guards ────────────────────────────────────────────────────────────
function abort(msg) {
  console.error(`[stage-d-v3] ABORT: ${msg}`);
  process.exit(1);
}

if (!process.env.RAILWAY_PROJECT_ID) {
  abort(
    "RAILWAY_PROJECT_ID not set — this script MUST run via " +
      "`railway run --service targenix.uz node …`. Never run it locally.",
  );
}

const rawKey = process.env.ENCRYPTION_KEY;
if (!rawKey) abort("ENCRYPTION_KEY not set in the injected environment.");
if (rawKey.length !== 32) {
  abort(
    `ENCRYPTION_KEY length is ${rawKey.length}; must be 32 — aborting to ` +
      "avoid silent key mismatch (same rule as server/_core/validateEnv.ts).",
  );
}

// Prefer the PUBLIC proxy URL — `MYSQL_URL` resolves to
// `mysql.railway.internal` which is only reachable from inside the
// Railway network. `railway run` injects env vars into a LOCAL shell,
// so the script process itself is OUTSIDE the internal network. The
// public proxy (`mainline.proxy.rlwy.net:xxxxx`) is what the running
// server uses too when routing through Railway's TCP proxy.
const mysqlUrl =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!mysqlUrl) abort("MYSQL_PUBLIC_URL / MYSQL_URL missing.");

const KEY_HASH = crypto.createHash("sha256").update(rawKey).digest("hex");

// ─── CLI parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}`) !== undefined;
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = flag("dry-run");
const APPLY = flag("apply");
const EXPECTED_KEY_HASH = value("expected-key-hash");
// Optional single-row filter. When set, only target_websites.id = ONLY_ID
// is considered a candidate. Used by the Stage D v3 CONTROLLED APPLY
// playbook to migrate one affiliate (Alijahon.uz, id=30003) first and
// verify delivery before touching the remaining four rows.
const ONLY_ID_RAW = value("id");
const ONLY_ID = ONLY_ID_RAW == null ? null : Number.parseInt(ONLY_ID_RAW, 10);
if (ONLY_ID_RAW != null && (!Number.isFinite(ONLY_ID) || ONLY_ID <= 0)) {
  abort(`--id must be a positive integer (got "${ONLY_ID_RAW}")`);
}

if (!DRY_RUN && !APPLY) {
  abort("Pass exactly one of --dry-run or --apply.");
}
if (DRY_RUN && APPLY) abort("--dry-run and --apply are mutually exclusive.");
if (!EXPECTED_KEY_HASH) {
  abort(
    "--expected-key-hash=<sha256 hex> is required. Fetch it with:\n" +
      `  railway run --service targenix.uz node -e "console.log(require('crypto').createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('hex'))"`,
  );
}
if (EXPECTED_KEY_HASH !== KEY_HASH) {
  console.error(`[stage-d-v3] KEY_HASH (live)     = ${KEY_HASH}`);
  console.error(`[stage-d-v3] KEY_HASH (expected) = ${EXPECTED_KEY_HASH}`);
  abort(
    "ENCRYPTION_KEY hash mismatch — refusing to proceed. This is the " +
      "exact class of failure that broke Stage D v1.",
  );
}

// ─── Banner ─────────────────────────────────────────────────────────────────
console.log("─".repeat(72));
console.log("  STAGE D v3 — api_key encryption migration");
console.log("─".repeat(72));
console.log(`  MODE            : ${DRY_RUN ? "DRY-RUN (read-only)" : "APPLY"}`);
console.log(`  SCOPE           : ${ONLY_ID ? `SINGLE ROW id=${ONLY_ID}` : "ALL ACTIVE ROWS"}`);
console.log(`  RAILWAY_ENV     : ${process.env.RAILWAY_ENVIRONMENT ?? "?"}`);
console.log(`  RAILWAY_SERVICE : ${process.env.RAILWAY_SERVICE_NAME ?? "?"}`);
console.log(`  KEY_HASH        : ${KEY_HASH}`);
console.log(`  KEY_LEN         : ${rawKey.length}`);
console.log("─".repeat(72));

// ─── Encryption helpers (mirror server/encryption.ts byte-for-byte) ─────────
function getAesKey() {
  // Identical to server/encryption.ts getKey(): AES-256 key is the sha256
  // of the raw ENCRYPTION_KEY. The `KEY_HASH` printed above IS this key
  // in hex — it is not just a fingerprint, it is literally the AES key
  // bytes in hex. That makes the guard above correspondingly strict.
  return crypto.createHash("sha256").update(rawKey).digest();
}
function encryptValue(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getAesKey(), iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}
function decryptValue(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(":");
  if (!ivHex || !encHex) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", getAesKey(), iv);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString("utf8");
}

// ─── Candidate detection ────────────────────────────────────────────────────
const SECRET_TOKEN_RE = /\{\{\s*SECRET:/;
const HEADER_SECRET_KEY_RE = /^(api[_-]?key|authorization)$/i;

/** Returns list of { section, fieldKey, value } for every plaintext secret. */
function findSecrets(templateConfig) {
  const hits = [];
  if (!templateConfig || typeof templateConfig !== "object") return hits;

  const bodyFields = Array.isArray(templateConfig.bodyFields)
    ? templateConfig.bodyFields
    : [];
  for (let i = 0; i < bodyFields.length; i++) {
    const f = bodyFields[i];
    if (!f || typeof f !== "object") continue;
    if (f.key !== "api_key") continue; // scope: only api_key in body
    if (typeof f.value !== "string" || !f.value.length) continue;
    if (SECRET_TOKEN_RE.test(f.value)) continue; // already migrated
    hits.push({
      section: "bodyFields",
      index: i,
      fieldKey: f.key,
      value: f.value,
    });
  }

  const headers = templateConfig.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [hk, hv] of Object.entries(headers)) {
      if (!HEADER_SECRET_KEY_RE.test(hk)) continue;
      if (typeof hv !== "string" || !hv.length) continue;
      if (SECRET_TOKEN_RE.test(hv)) continue;
      hits.push({
        section: "headers",
        fieldHeader: hk,
        fieldKey: "api_key", // all header hits are stored under secrets.api_key
        value: hv,
      });
    }
  }

  return hits;
}

/** Applies a migration plan to a templateConfig clone, returns new config. */
function applyPlanToConfig(config, hits, ciphertextByFieldKey) {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  next.secrets = next.secrets && typeof next.secrets === "object" ? next.secrets : {};

  for (const hit of hits) {
    const cipher = ciphertextByFieldKey[hit.fieldKey];
    if (!cipher) throw new Error(`Missing ciphertext for ${hit.fieldKey}`);
    next.secrets[hit.fieldKey] = cipher;

    if (hit.section === "bodyFields") {
      next.bodyFields = Array.isArray(next.bodyFields) ? [...next.bodyFields] : [];
      next.bodyFields[hit.index] = {
        ...next.bodyFields[hit.index],
        value: `{{SECRET:${hit.fieldKey}}}`,
      };
    } else if (hit.section === "headers") {
      next.headers = { ...(next.headers ?? {}) };
      next.headers[hit.fieldHeader] = `{{SECRET:${hit.fieldKey}}}`;
    }
  }
  return next;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const conn = await mysql.createConnection(mysqlUrl);

try {
  const baseSql =
    "SELECT id, userId, name, templateType, templateId, templateConfig " +
    "FROM target_websites " +
    "WHERE isActive = 1 AND templateConfig IS NOT NULL";
  const [rows] = ONLY_ID
    ? await conn.query(`${baseSql} AND id = ? ORDER BY id ASC`, [ONLY_ID])
    : await conn.query(`${baseSql} ORDER BY id ASC`);

  if (ONLY_ID && rows.length === 0) {
    abort(`--id=${ONLY_ID} did not match any active target_websites row.`);
  }

  const plan = [];
  for (const row of rows) {
    let cfg = row.templateConfig;
    if (typeof cfg === "string") {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        console.warn(
          `[stage-d-v3] id=${row.id} templateConfig is an unparseable string — skipping`,
        );
        continue;
      }
    }
    const hits = findSecrets(cfg);
    if (!hits.length) continue;
    plan.push({ row, cfg, hits });
  }

  console.log(`  Candidates found : ${plan.length}`);
  console.log("─".repeat(72));

  if (plan.length === 0) {
    console.log("No candidates — nothing to migrate. Exiting cleanly.");
    await conn.end();
    process.exit(0);
  }

  for (const { row, hits } of plan) {
    console.log(
      `  id=${String(row.id).padStart(6)} user=${row.userId} ` +
        `type=${row.templateType} name="${row.name}"`,
    );
    for (const h of hits) {
      const preview = h.value.length > 6 ? h.value.slice(0, 3) + "…" + h.value.slice(-3) : "***";
      if (h.section === "bodyFields") {
        console.log(
          `      bodyFields[${h.index}].${h.fieldKey} = "${preview}" → "{{SECRET:${h.fieldKey}}}"`,
        );
      } else {
        console.log(
          `      headers["${h.fieldHeader}"] = "${preview}" → "{{SECRET:${h.fieldKey}}}"`,
        );
      }
    }
  }
  console.log("─".repeat(72));

  if (DRY_RUN) {
    console.log("DRY-RUN complete. No DB changes made.");
    console.log(
      "To apply: re-run with --apply (backup will be written automatically).",
    );
    await conn.end();
    process.exit(0);
  }

  // ─── APPLY ────────────────────────────────────────────────────────────────
  // 1. Write backup FIRST (survives any subsequent crash).
  const scopeSuffix = ONLY_ID ? `_id${ONLY_ID}` : "_all";
  const backupName = `backup_api_keys_stageD_v3${scopeSuffix}_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  const backupPath = path.resolve(process.cwd(), backupName);
  const backupPayload = {
    stage: "D-v3",
    timestamp: new Date().toISOString(),
    keyHash: KEY_HASH,
    railwayEnv: process.env.RAILWAY_ENVIRONMENT ?? null,
    railwayService: process.env.RAILWAY_SERVICE_NAME ?? null,
    rows: plan.map(({ row, cfg, hits }) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      originalTemplateConfig: cfg,
      hits: hits.map((h) => ({
        section: h.section,
        index: h.index ?? null,
        fieldHeader: h.fieldHeader ?? null,
        fieldKey: h.fieldKey,
        plaintext: h.value,
      })),
    })),
  };
  await fs.writeFile(backupPath, JSON.stringify(backupPayload, null, 2), {
    mode: 0o600,
  });
  console.log(`Backup written: ${backupPath}  (chmod 0600)`);

  // 2. Transaction + per-row round-trip verify.
  await conn.beginTransaction();
  let committed = false;
  try {
    for (const { row, cfg, hits } of plan) {
      // Consistency guard: when a single row references the SAME secret
      // key in multiple places (e.g. 100k.uz puts api_key in both the
      // body and an `api_key` header), every occurrence must hold the
      // same plaintext. Otherwise the single `{{SECRET:api_key}}` token
      // we write back would silently overwrite one of the values with
      // the other. Abort the whole migration if this invariant breaks.
      const plaintextByKey = {};
      for (const h of hits) {
        const prev = plaintextByKey[h.fieldKey];
        if (prev === undefined) {
          plaintextByKey[h.fieldKey] = h.value;
          continue;
        }
        if (prev !== h.value) {
          throw new Error(
            `id=${row.id} inconsistent plaintext for fieldKey="${h.fieldKey}" ` +
              `across body/headers — manual review required before migration.`,
          );
        }
      }

      // One ciphertext per distinct fieldKey in this row (currently only api_key).
      const cipherByKey = {};
      for (const h of hits) {
        if (cipherByKey[h.fieldKey] !== undefined) continue;
        cipherByKey[h.fieldKey] = encryptValue(h.value);
      }
      const newCfg = applyPlanToConfig(cfg, hits, cipherByKey);

      await conn.query(
        "UPDATE target_websites SET templateConfig = ? WHERE id = ?",
        [JSON.stringify(newCfg), row.id],
      );

      // Re-read and round-trip verify — this is the guard that would have
      // caught the Stage D v1 failure the moment it happened.
      const [verifyRows] = await conn.query(
        "SELECT templateConfig FROM target_websites WHERE id = ?",
        [row.id],
      );
      const stored = verifyRows[0]?.templateConfig;
      const storedCfg = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (!storedCfg?.secrets) {
        throw new Error(
          `id=${row.id} verify failed: secrets map missing after UPDATE`,
        );
      }
      for (const h of hits) {
        const cipher = storedCfg.secrets[h.fieldKey];
        if (!cipher) {
          throw new Error(
            `id=${row.id} verify failed: secrets.${h.fieldKey} missing`,
          );
        }
        const roundtrip = decryptValue(cipher);
        if (roundtrip !== h.value) {
          throw new Error(
            `id=${row.id} verify failed: decrypt(secrets.${h.fieldKey}) ` +
              `!== original plaintext`,
          );
        }
      }
      console.log(
        `  ✓ id=${String(row.id).padStart(6)} migrated + round-trip verified`,
      );
    }

    await conn.commit();
    committed = true;
    console.log("─".repeat(72));
    console.log(`COMMIT OK — ${plan.length} row(s) migrated.`);
    console.log(`Backup retained at: ${backupPath}`);
    console.log(
      "Run the rollback script if any live delivery fails in the next 15 min:",
    );
    console.log(
      `  railway run --service targenix.uz node tooling/mysql/stage-d-v3-rollback.mjs \\\n    --backup=${backupName} --expected-key-hash=${KEY_HASH} --apply`,
    );
  } catch (err) {
    if (!committed) {
      console.error(`[stage-d-v3] FAILURE during apply: ${err.message}`);
      await conn.rollback();
      console.error(
        "[stage-d-v3] ROLLBACK executed — no rows were modified. " +
          "Backup file is preserved for forensic review.",
      );
    }
    throw err;
  }
} finally {
  await conn.end();
}

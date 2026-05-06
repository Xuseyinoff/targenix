/**
 * Stage D v3 — ROLLBACK for the api_key encryption migration.
 *
 * Reads a backup file produced by stage-d-v3-migrate.mjs and restores the
 * ORIGINAL templateConfig (pre-encryption) for every row recorded in the
 * backup. Used when a smoke test surfaces a delivery failure and we need
 * to revert the entire batch fast.
 *
 * Invocation (must use `railway run` — same env parity guard as migrate):
 *   railway run --service targenix.uz node \
 *     tooling/mysql/stage-d-v3-rollback.mjs \
 *     --backup=<filename> \
 *     --expected-key-hash=<prod-hash> \
 *     [--dry-run | --apply]
 *
 * The `--expected-key-hash` guard is retained here even though rollback
 * does not itself encrypt/decrypt: it is the single signal proving we are
 * connected to the same environment that originally produced the backup.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

function abort(msg) {
  console.error(`[stage-d-v3-rollback] ABORT: ${msg}`);
  process.exit(1);
}

if (!process.env.RAILWAY_PROJECT_ID) {
  abort(
    "RAILWAY_PROJECT_ID not set — run via `railway run --service targenix.uz`.",
  );
}
const rawKey = process.env.ENCRYPTION_KEY;
if (!rawKey) abort("ENCRYPTION_KEY not set.");
if (rawKey.length !== 32) abort(`ENCRYPTION_KEY length is ${rawKey.length}; must be 32.`);

// Public proxy preferred — see note in stage-d-v3-migrate.mjs for the
// rationale (railway run executes locally, outside the internal network).
const mysqlUrl =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!mysqlUrl) abort("MYSQL_PUBLIC_URL / MYSQL_URL missing.");

const KEY_HASH = crypto.createHash("sha256").update(rawKey).digest("hex");

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const DRY_RUN = flag("dry-run");
const APPLY = flag("apply");
const BACKUP_FILE = value("backup");
const EXPECTED_KEY_HASH = value("expected-key-hash");

if (!BACKUP_FILE) abort("--backup=<filename> is required.");
if (!DRY_RUN && !APPLY) abort("Pass exactly one of --dry-run or --apply.");
if (DRY_RUN && APPLY) abort("--dry-run and --apply are mutually exclusive.");
if (!EXPECTED_KEY_HASH) abort("--expected-key-hash=<hex> is required.");
if (EXPECTED_KEY_HASH !== KEY_HASH) {
  console.error(`[stage-d-v3-rollback] KEY_HASH (live)     = ${KEY_HASH}`);
  console.error(`[stage-d-v3-rollback] KEY_HASH (expected) = ${EXPECTED_KEY_HASH}`);
  abort("ENCRYPTION_KEY hash mismatch.");
}

const backupPath = path.resolve(process.cwd(), BACKUP_FILE);
const raw = await fs.readFile(backupPath, "utf8");
const backup = JSON.parse(raw);

if (backup.stage !== "D-v3") {
  abort(`Backup stage is "${backup.stage}", expected "D-v3".`);
}
if (backup.keyHash !== KEY_HASH) {
  console.error(`[stage-d-v3-rollback] Backup keyHash = ${backup.keyHash}`);
  console.error(`[stage-d-v3-rollback] Live   keyHash = ${KEY_HASH}`);
  abort(
    "Backup was produced with a DIFFERENT ENCRYPTION_KEY — refusing to " +
      "restore. This would otherwise re-introduce data inconsistency.",
  );
}

console.log("─".repeat(72));
console.log("  STAGE D v3 — ROLLBACK");
console.log("─".repeat(72));
console.log(`  MODE       : ${DRY_RUN ? "DRY-RUN (read-only)" : "APPLY"}`);
console.log(`  Backup     : ${backupPath}`);
console.log(`  Created    : ${backup.timestamp}`);
console.log(`  Rows       : ${backup.rows.length}`);
console.log(`  KEY_HASH   : ${KEY_HASH}`);
console.log("─".repeat(72));

const conn = await mysql.createConnection(mysqlUrl);

try {
  if (DRY_RUN) {
    for (const r of backup.rows) {
      console.log(`  Would restore id=${r.id} name="${r.name}"`);
    }
    console.log("─".repeat(72));
    console.log("DRY-RUN complete. No DB changes made.");
    await conn.end();
    process.exit(0);
  }

  await conn.beginTransaction();
  try {
    for (const r of backup.rows) {
      await conn.query(
        "UPDATE target_websites SET templateConfig = ? WHERE id = ?",
        [JSON.stringify(r.originalTemplateConfig), r.id],
      );

      const [verify] = await conn.query(
        "SELECT templateConfig FROM target_websites WHERE id = ?",
        [r.id],
      );
      const stored = verify[0]?.templateConfig;
      const storedCfg = typeof stored === "string" ? JSON.parse(stored) : stored;

      // Sanity check: the original plaintext values must now be back in
      // the config exactly where the backup recorded them.
      for (const hit of r.hits) {
        if (hit.section === "bodyFields") {
          const got = storedCfg?.bodyFields?.[hit.index]?.value;
          if (got !== hit.plaintext) {
            throw new Error(
              `id=${r.id} restore verify failed: bodyFields[${hit.index}].value mismatch`,
            );
          }
        } else if (hit.section === "headers") {
          const got = storedCfg?.headers?.[hit.fieldHeader];
          if (got !== hit.plaintext) {
            throw new Error(
              `id=${r.id} restore verify failed: headers["${hit.fieldHeader}"] mismatch`,
            );
          }
        }
      }
      console.log(`  ✓ id=${String(r.id).padStart(6)} restored + verified`);
    }
    await conn.commit();
    console.log("─".repeat(72));
    console.log(`COMMIT OK — ${backup.rows.length} row(s) restored.`);
  } catch (err) {
    console.error(`[stage-d-v3-rollback] FAILURE: ${err.message}`);
    await conn.rollback();
    console.error(
      "[stage-d-v3-rollback] ROLLBACK executed — no rows were modified.",
    );
    throw err;
  }
} finally {
  await conn.end();
}

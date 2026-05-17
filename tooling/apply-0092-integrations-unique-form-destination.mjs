/**
 * Apply migration 0092 — UNIQUE INDEX on integrations(userId, formId, destinationId)
 * for live (deletedAt IS NULL) rows only. Implemented as a MySQL 8 functional
 * unique index — see the SQL file for the rationale.
 *
 * Pre-flight: tooling/probe-integrations-duplicates.mjs MUST report 0 live
 * duplicates first. Cleanup of pre-existing duplicates is the operator's
 * responsibility (e.g. via tooling/cleanup-duplicate-integration-600099.mjs).
 *
 * After the index is created, INSERT a row into `__drizzle_migrations` keyed
 * on sha256(0092_*.sql) so drizzle-kit migrate won't try to re-run.
 *
 * Idempotent: safe to re-run.
 *
 * Usage:
 *   railway run --service=targenix.uz node tooling/apply-0092-integrations-unique-form-destination.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const SQL_FILE = "drizzle/0092_integrations_unique_form_destination.sql";
const TABLE = "integrations";
const INDEX = "uniq_integrations_live_form_dest";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[apply-0092] No mysql:// URL in env. Set MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL.");
  process.exit(1);
}

console.log("[apply-0092] Connecting to:", url.replace(/:\/\/[^@]+@/, "://<hidden>@"));
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function indexExists(name) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [TABLE, name],
  );
  return rows[0].n > 0;
}

async function liveDuplicateCount() {
  const [rows] = await conn.query(`
    SELECT COUNT(*) AS dupes FROM (
      SELECT userId, formId, destinationId
        FROM integrations
       WHERE deletedAt IS NULL
         AND formId IS NOT NULL
         AND destinationId IS NOT NULL
       GROUP BY userId, formId, destinationId
      HAVING COUNT(*) > 1
    ) t
  `);
  return rows[0].dupes;
}

async function rowCount() {
  const [r] = await conn.query(`SELECT COUNT(*) AS n FROM \`${TABLE}\``);
  return r[0].n;
}

let exitCode = 0;
try {
  console.log(`\n[apply-0092] BEFORE — ${TABLE} row count: ${await rowCount()}`);

  const dupes = await liveDuplicateCount();
  console.log(`[apply-0092] Live duplicate count: ${dupes}`);
  if (dupes > 0) {
    console.error("[apply-0092] ABORT — live duplicates would block CREATE INDEX. Run tooling/probe-integrations-duplicates.mjs for detail.");
    process.exit(1);
  }

  if (await indexExists(INDEX)) {
    console.log(`[apply-0092] ${INDEX} already exists — SKIP DDL`);
  } else {
    process.stdout.write(`[apply-0092] Creating ${INDEX}... `);
    // Note: multi-line CREATE INDEX with functional expression — pass the
    // raw SQL from the file so we don't drift between SQL and JS literals.
    const sql = readFileSync(SQL_FILE, "utf8");
    await conn.query(sql);
    console.log("OK");
  }

  // Verify
  if (!(await indexExists(INDEX))) {
    console.error(`[apply-0092] ERROR — ${INDEX} still missing after apply.`);
    exitCode = 1;
  } else {
    console.log(`[apply-0092] Verified: ${INDEX} present.`);
  }

  // Backfill __drizzle_migrations row keyed by sha256(sql).
  const hash = crypto.createHash("sha256").update(readFileSync(SQL_FILE)).digest("hex");
  const [existing] = await conn.query(
    "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
    [hash],
  );
  if (existing.length > 0) {
    console.log(`[apply-0092] __drizzle_migrations row already present (id=${existing[0].id}) — SKIP`);
  } else {
    const when = Date.now();
    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [hash, when],
    );
    console.log(`[apply-0092] Inserted __drizzle_migrations row — hash=${hash.slice(0, 12)}… when=${when}`);
  }
} catch (err) {
  console.error("[apply-0092] FATAL:", err.message);
  exitCode = 1;
} finally {
  await conn.end();
}

console.log(exitCode === 0 ? "\n[apply-0092] Done." : "\n[apply-0092] FAILED.");
process.exit(exitCode);

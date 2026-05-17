/**
 * Apply migration 0091 — destinations indexes + legacy-name cleanup.
 *
 * Operations (idempotent; each one is a no-op if already in desired state):
 *   1. CREATE idx_destinations_user_id          (userId)
 *   2. CREATE idx_destinations_user_app         (userId, appKey)
 *   3. CREATE idx_destinations_connection_id    (connectionId)
 *   4. DROP   idx_target_websites_connection_id (legacy from 0069 rename)
 *
 * Ordering matters: step 3 runs BEFORE step 4 so the `connectionId`
 * column is covered by at least one index at all times — no query-plan
 * regression window.
 *
 * After the DDL succeeds, INSERT a row into `__drizzle_migrations` keyed
 * on sha256(0091_destinations_indexes.sql) so `pnpm db:push` /
 * `drizzle-kit migrate` will not attempt to re-run this migration.
 * Skipped if a row with the same hash already exists.
 *
 * Usage:
 *   railway run node tooling/apply-0091-destinations-indexes.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const SQL_FILE = "drizzle/0091_destinations_indexes.sql";
const TABLE = "destinations";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[apply-0091] No mysql:// URL in env. Set MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL.");
  process.exit(1);
}

console.log("[apply-0091] Connecting to:", url.replace(/:\/\/[^@]+@/, "://<hidden>@"));
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function indexExists(name) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [TABLE, name],
  );
  return rows[0].n > 0;
}

async function listIndexes() {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [TABLE],
  );
  return rows;
}

async function rowCount() {
  const [r] = await conn.query(`SELECT COUNT(*) AS n FROM \`${TABLE}\``);
  return r[0].n;
}

async function createIndexIfMissing(name, columnsSql) {
  if (await indexExists(name)) {
    console.log(`[apply-0091] ${name} already exists — SKIP`);
    return;
  }
  process.stdout.write(`[apply-0091] Creating ${name} on (${columnsSql})... `);
  await conn.query(`CREATE INDEX ${name} ON ${TABLE} (${columnsSql})`);
  console.log("OK");
}

async function dropIndexIfPresent(name) {
  if (!(await indexExists(name))) {
    console.log(`[apply-0091] Legacy ${name} already gone — SKIP`);
    return;
  }
  process.stdout.write(`[apply-0091] Dropping legacy ${name}... `);
  await conn.query(`DROP INDEX ${name} ON ${TABLE}`);
  console.log("OK");
}

let exitCode = 0;
try {
  console.log(`\n[apply-0091] BEFORE — ${TABLE} row count: ${await rowCount()}`);
  console.log("[apply-0091] BEFORE — existing indexes:");
  console.table(await listIndexes());

  console.log("\n[apply-0091] Applying DDL...");
  await createIndexIfMissing("idx_destinations_user_id", "userId");
  await createIndexIfMissing("idx_destinations_user_app", "userId, appKey");
  await createIndexIfMissing("idx_destinations_connection_id", "connectionId");
  await dropIndexIfPresent("idx_target_websites_connection_id");

  console.log("\n[apply-0091] AFTER — indexes:");
  console.table(await listIndexes());

  const expected = [
    "idx_destinations_user_id",
    "idx_destinations_user_app",
    "idx_destinations_connection_id",
  ];
  const missing = [];
  for (const n of expected) {
    if (!(await indexExists(n))) missing.push(n);
  }
  if (missing.length > 0) {
    console.error("[apply-0091] ERROR — expected indexes still missing:", missing);
    exitCode = 1;
  }
  if (await indexExists("idx_target_websites_connection_id")) {
    console.error("[apply-0091] ERROR — legacy idx_target_websites_connection_id still present.");
    exitCode = 1;
  }
  if (exitCode === 0) {
    console.log("[apply-0091] State check: 3 expected indexes present, legacy removed ✓");
  }

  // Backfill __drizzle_migrations row keyed by sha256(sql).
  const hash = crypto.createHash("sha256").update(readFileSync(SQL_FILE)).digest("hex");
  const [existing] = await conn.query(
    "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
    [hash],
  );
  if (existing.length > 0) {
    console.log(`[apply-0091] __drizzle_migrations row already present (id=${existing[0].id}) — SKIP`);
  } else {
    const when = Date.now();
    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [hash, when],
    );
    console.log(`[apply-0091] Inserted __drizzle_migrations row — hash=${hash.slice(0, 12)}… when=${when}`);
  }
} catch (err) {
  console.error("[apply-0091] FATAL:", err.message);
  exitCode = 1;
} finally {
  await conn.end();
}

console.log(exitCode === 0 ? "\n[apply-0091] Done." : "\n[apply-0091] FAILED.");
process.exit(exitCode);

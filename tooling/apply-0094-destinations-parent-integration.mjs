/**
 * Apply migration 0094 — destinations.parentIntegrationId.
 *
 * Destinations Cleanup Sprint, PR 2/4. Adds a nullable INT column + a
 * single-column index. The raw DDL in 0094_*.sql is NOT idempotent (ALTER
 * TABLE ADD COLUMN errors on duplicate column; CREATE INDEX errors on
 * duplicate index name), so this script probes information_schema first
 * and skips whichever piece is already in place.
 *
 * Backfills the `__drizzle_migrations` row keyed on sha256(0094_*.sql) so
 * drizzle-kit migrate considers the migration applied.
 *
 * Usage:
 *   railway run --service=targenix.uz node tooling/apply-0094-destinations-parent-integration.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const SQL_FILE = "drizzle/0094_destinations_parent_integration.sql";
const TABLE = "destinations";
const COLUMN = "parentIntegrationId";
const INDEX = "idx_destinations_parent_integration";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error(
    "[apply-0094] No mysql:// URL in env. Set MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL.",
  );
  process.exit(1);
}

console.log(
  "[apply-0094] Connecting to:",
  url.replace(/:\/\/[^@]+@/, "://<hidden>@"),
);
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function columnExists(table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return rows[0].n > 0;
}

async function indexExists(table, index) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index],
  );
  return rows[0].n > 0;
}

async function listIndexes(table) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [table],
  );
  return rows;
}

let exitCode = 0;
try {
  const hadColumn = await columnExists(TABLE, COLUMN);
  const hadIndex = await indexExists(TABLE, INDEX);
  console.log("\n[apply-0094] BEFORE state:");
  console.log(`  ${TABLE}.${COLUMN}: ${hadColumn ? "EXISTS" : "missing"}`);
  console.log(`  index ${INDEX}: ${hadIndex ? "EXISTS" : "missing"}`);

  if (!hadColumn) {
    console.log(
      `\n[apply-0094] Adding column ${TABLE}.${COLUMN} (ALGORITHM=INPLACE, LOCK=NONE)`,
    );
    await conn.query(
      `ALTER TABLE \`${TABLE}\` ADD COLUMN \`${COLUMN}\` INT NULL, ALGORITHM=INPLACE, LOCK=NONE`,
    );
    console.log("[apply-0094] Column added OK");
  } else {
    console.log("\n[apply-0094] Column already present — SKIP ADD COLUMN");
  }

  if (!hadIndex) {
    console.log(`\n[apply-0094] Creating index ${INDEX}`);
    await conn.query(
      `CREATE INDEX \`${INDEX}\` ON \`${TABLE}\` (\`${COLUMN}\`)`,
    );
    console.log("[apply-0094] Index created OK");
  } else {
    console.log("\n[apply-0094] Index already present — SKIP CREATE INDEX");
  }

  console.log("\n[apply-0094] AFTER state:");
  const nowHasColumn = await columnExists(TABLE, COLUMN);
  const nowHasIndex = await indexExists(TABLE, INDEX);
  console.log(`  ${TABLE}.${COLUMN}: ${nowHasColumn ? "EXISTS" : "MISSING"}`);
  console.log(`  index ${INDEX}: ${nowHasIndex ? "EXISTS" : "MISSING"}`);
  if (!nowHasColumn || !nowHasIndex) {
    exitCode = 1;
    console.error("[apply-0094] ERROR — column or index missing after apply.");
  }

  if (exitCode === 0) {
    console.log(`\n[apply-0094] ${TABLE} indexes:`);
    console.table(await listIndexes(TABLE));
  }

  // Backfill __drizzle_migrations row keyed by sha256(sql).
  const hash = crypto.createHash("sha256").update(readFileSync(SQL_FILE)).digest("hex");
  const [existing] = await conn.query(
    "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
    [hash],
  );
  if (existing.length > 0) {
    console.log(
      `\n[apply-0094] __drizzle_migrations row already present (id=${existing[0].id}) — SKIP`,
    );
  } else {
    const when = Date.now();
    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [hash, when],
    );
    console.log(
      `\n[apply-0094] Inserted __drizzle_migrations row — hash=${hash.slice(0, 12)}… when=${when}`,
    );
  }
} catch (err) {
  console.error("[apply-0094] FATAL:", err.message);
  exitCode = 1;
} finally {
  await conn.end();
}

console.log(exitCode === 0 ? "\n[apply-0094] Done." : "\n[apply-0094] FAILED.");
process.exit(exitCode);

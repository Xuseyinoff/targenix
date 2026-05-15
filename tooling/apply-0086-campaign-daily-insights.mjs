/**
 * Apply migration 0086 — campaign_daily_insights table (Phase 2).
 *
 * Creates the daily-grain spend cache used by the rollup worker to fill
 * fact_attribution_daily.spendAmount. CREATE TABLE IF NOT EXISTS is INSTANT
 * DDL (no row lock; new table). Idempotent.
 *
 * Usage:
 *   railway run node tooling/apply-0086-campaign-daily-insights.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url) {
  console.error("No MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL set");
  process.exit(1);
}
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function describe() {
  const [tableRow] = await conn.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = 'campaign_daily_insights'`,
  );
  const present = tableRow.length > 0;
  if (!present) return { present, columnCount: 0, indexes: [] };
  const [colRows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'campaign_daily_insights'`,
  );
  const [idxRows] = await conn.query(
    `SELECT DISTINCT index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'campaign_daily_insights'`,
  );
  return {
    present,
    columnCount: Number(colRows[0]?.n ?? 0),
    indexes: idxRows.map((r) => r.index_name),
  };
}

function printState(label, s) {
  console.log(`\n[0086] ${label}:`);
  console.log(`  campaign_daily_insights present: ${s.present ? "yes" : "no"}`);
  if (s.present) {
    console.log(`  columns: ${s.columnCount}`);
    console.log(`  indexes: ${s.indexes.join(", ")}`);
  }
}

printState("BEFORE", await describe());

await conn.query(readFileSync("drizzle/0086_campaign_daily_insights.sql", "utf8"));

printState("AFTER", await describe());

console.log("\n[0086] Done.");
await conn.end();

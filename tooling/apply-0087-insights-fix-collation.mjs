/**
 * Apply migration 0087 — fix collation on the two Insights tables.
 *
 * The two tables were created with utf8mb4_unicode_ci while the rest of
 * the DB uses utf8mb4_0900_ai_ci (MySQL 8 default). Any cross-table
 * comparison fails with ER_CANT_AGGREGATE_2COLLATIONS. Realigning both
 * tables to the DB default is metadata-only on MySQL 8.
 *
 * Usage:
 *   railway run node tooling/apply-0087-insights-fix-collation.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url) {
  console.error("No DB URL set");
  process.exit(1);
}
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function describe(name) {
  const [tableRow] = await conn.query(
    `SELECT table_collation FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = ?`,
    [name],
  );
  const [currCol] = await conn.query(
    `SELECT column_name, collation_name FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = 'currency'`,
    [name],
  );
  return {
    tableCollation: tableRow[0]?.table_collation ?? "(absent)",
    currencyCollation: currCol[0]?.collation_name ?? "(absent)",
  };
}

console.log("[0087] BEFORE:");
console.table({
  fact_attribution_daily: await describe("fact_attribution_daily"),
  campaign_daily_insights: await describe("campaign_daily_insights"),
});

await conn.query(readFileSync("drizzle/0087_insights_fix_collation.sql", "utf8"));

console.log("\n[0087] AFTER:");
console.table({
  fact_attribution_daily: await describe("fact_attribution_daily"),
  campaign_daily_insights: await describe("campaign_daily_insights"),
});

console.log("\n[0087] Done.");
await conn.end();

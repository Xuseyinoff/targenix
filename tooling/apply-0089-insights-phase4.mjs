/**
 * Apply migration 0089 — Insights Phase 4 schema.
 *
 * Creates the `fx_rates` table (daily USD/UZS rates from CBU) and adds
 * `fact_attribution_daily.pipelineAmount` (in-flight revenue counter).
 *
 * Both operations are INSTANT DDL on MySQL 8 InnoDB and idempotent.
 *
 * Usage:
 *   railway run node tooling/apply-0089-insights-phase4.mjs
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

async function describe() {
  const [fxTable] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = 'fx_rates'`,
  );
  const [pipCol] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'fact_attribution_daily'
        AND column_name = 'pipelineAmount'`,
  );
  return {
    fxTablePresent: fxTable.length > 0,
    pipelineColumn: pipCol[0] ?? null,
  };
}

function printState(label, s) {
  console.log(`\n[0089] ${label}:`);
  console.log(`  fx_rates table:                  ${s.fxTablePresent ? "present" : "absent"}`);
  console.log(`  fact_attribution_daily.pipelineAmount:`);
  if (s.pipelineColumn) {
    console.table(s.pipelineColumn);
  } else {
    console.log("    (absent)");
  }
}

printState("BEFORE", await describe());

await conn.query(readFileSync("drizzle/0089_insights_phase4_fx_and_pipeline.sql", "utf8"));

printState("AFTER", await describe());

console.log("\n[0089] Done.");
await conn.end();

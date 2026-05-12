/**
 * Apply migrations 0074 (rename 6 tables + create back-compat VIEWs) and
 * 0075 (rename 13 indexes) together. Both are idempotent.
 *
 * Order: 0074 then 0075 — 0075 references the renamed table names.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0074-0075.mjs
 *   railway run --service WORKER node tooling/apply-0074-0075.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function snapshotTables() {
  const [rows] = await conn.query(
    `SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN (
          'ad_accounts_cache','ad_accounts',
          'campaigns_cache','campaigns',
          'ad_sets_cache','ad_sets',
          'campaign_insights_cache','campaign_insights',
          'integration_health','circuit_breakers',
          'integration_health_events','circuit_breaker_events'
        )
      ORDER BY table_name`,
  );
  return rows;
}

async function snapshotIndexes() {
  const [rows] = await conn.query(
    `SELECT table_name, index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name IN ('ad_accounts','campaigns','ad_sets','campaign_insights','circuit_breakers','circuit_breaker_events')
        AND index_name <> 'PRIMARY'
      GROUP BY table_name, index_name
      ORDER BY table_name, index_name`,
  );
  return rows;
}

console.log("=== 0074 — RENAME 6 tables ===");
console.log("[pre]");
console.table(await snapshotTables());
await conn.query(readFileSync("drizzle/0074_rename_cache_and_circuit_breakers.sql", "utf8"));
console.log("[post]");
console.table(await snapshotTables());

console.log("\n=== 0075 — RENAME 13 indexes ===");
console.log("[pre]");
console.table(await snapshotIndexes());
await conn.query(readFileSync("drizzle/0075_rename_legacy_index_names_v2.sql", "utf8"));
console.log("[post]");
console.table(await snapshotIndexes());

console.log("\n[0074+0075] Done.");
await conn.end();

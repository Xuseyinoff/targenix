/**
 * Apply migration 0076 — drop the 6 back-compat VIEWs.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0076-drop-views-v2.mjs
 *   railway run --service WORKER node tooling/apply-0076-drop-views-v2.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function snapshot() {
  const [rows] = await conn.query(
    `SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('ad_accounts_cache','campaigns_cache','ad_sets_cache','campaign_insights_cache','integration_health','integration_health_events')
      ORDER BY table_name`,
  );
  return rows;
}

console.log("[0076] Pre-state:");
console.table(await snapshot());
await conn.query(readFileSync("drizzle/0076_drop_legacy_views_v2.sql", "utf8"));
console.log("[0076] Post-state:");
console.table(await snapshot());
console.log("[0076] Done.");
await conn.end();

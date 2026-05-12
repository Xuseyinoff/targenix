/**
 * Apply migration 0070 — drop the legacy `target_websites` and
 * `integration_destinations` VIEWs left behind by 0069.
 *
 * Safe + idempotent. `DROP VIEW IF EXISTS` is a no-op when missing.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0070-drop-legacy-views.mjs
 *   railway run --service WORKER node tooling/apply-0070-drop-legacy-views.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0070] DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function listLegacyViews() {
  const [rows] = await conn.query(
    `SELECT table_name, table_type
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('target_websites','integration_destinations')`,
  );
  return rows;
}

console.log("[0070] Pre-state:");
console.log(await listLegacyViews());

const sql = readFileSync("drizzle/0070_drop_legacy_views.sql", "utf8");
await conn.query(sql);

console.log("[0070] Post-state:");
console.log(await listLegacyViews());

console.log("[0070] Done. Both legacy views dropped (or were absent).");
await conn.end();

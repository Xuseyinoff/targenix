/**
 * Apply migration 0073 — rename legacy index names to match the
 * post-0069 table names. Pure SQL identifier cleanup.
 *
 * MySQL 8 `RENAME INDEX` is INSTANT (metadata-only). Indexes keep their
 * B-tree pages intact. Idempotent — re-runs are no-ops.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0073-rename-indexes.mjs
 *   railway run --service WORKER node tooling/apply-0073-rename-indexes.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0073] DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function snapshot() {
  const [rows] = await conn.query(
    `SELECT table_name, index_name
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND (
          index_name LIKE 'idx_integrations_target_website%'
          OR index_name LIKE 'idx_integrations_destination_id'
          OR index_name LIKE 'idx_integration_destinations_%'
          OR index_name LIKE 'idx_integration_routes_%'
          OR index_name LIKE 'uniq_integration_destination'
          OR index_name LIKE 'uniq_integration_route'
        )
      GROUP BY table_name, index_name
      ORDER BY table_name, index_name`,
  );
  return rows;
}

console.log("[0073] Pre-state:");
console.table(await snapshot());

const sql = readFileSync("drizzle/0073_rename_legacy_index_names.sql", "utf8");
await conn.query(sql);

console.log("[0073] Post-state:");
console.table(await snapshot());

console.log("[0073] Done.");
await conn.end();

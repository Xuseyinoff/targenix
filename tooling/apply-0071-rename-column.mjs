/**
 * Apply migration 0071 — rename SQL column targetWebsiteId → destinationId on
 * both `integrations` and `integration_routes`.
 *
 * MySQL 8 `RENAME COLUMN` is INSTANT (metadata-only). Indexes follow the
 * column automatically. The script is idempotent: guard conditions skip
 * the ALTER if the column has already been renamed.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0071-rename-column.mjs
 *   railway run --service WORKER node tooling/apply-0071-rename-column.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0071] DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function snapshot() {
  const [rows] = await conn.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN ('integrations','integration_routes')
        AND column_name IN ('targetWebsiteId','destinationId')
      ORDER BY table_name, column_name`,
  );
  return rows;
}

console.log("[0071] Pre-state:");
console.table(await snapshot());

const sql = readFileSync("drizzle/0071_rename_target_website_id_column.sql", "utf8");
await conn.query(sql);

console.log("[0071] Post-state:");
console.table(await snapshot());

console.log("[0071] Done.");
await conn.end();

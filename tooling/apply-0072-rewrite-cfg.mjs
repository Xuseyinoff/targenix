/**
 * Apply migration 0072 — rewrite legacy JSON config key
 * `config.targetWebsiteId` → `config.destinationId` on integrations.
 *
 * Idempotent; only updates rows where the legacy key is present and the
 * modern key is absent.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0072-rewrite-cfg.mjs
 *   railway run --service WORKER node tooling/apply-0072-rewrite-cfg.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0072] DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function audit() {
  const [rows] = await conn.query(
    `SELECT
       COUNT(*) AS total,
       SUM(JSON_EXTRACT(config, '$.targetWebsiteId') IS NOT NULL) AS withLegacy,
       SUM(JSON_EXTRACT(config, '$.destinationId') IS NOT NULL) AS withModern
     FROM integrations`,
  );
  return rows[0];
}

console.log("[0072] Pre-state:");
console.log(await audit());

const sql = readFileSync("drizzle/0072_rewrite_cfg_target_website_id.sql", "utf8");
const [result] = await conn.query(sql);
console.log(`[0072] Rows affected: ${result.affectedRows}`);

console.log("[0072] Post-state:");
console.log(await audit());

console.log("[0072] Done.");
await conn.end();

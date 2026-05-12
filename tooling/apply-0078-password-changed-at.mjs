/**
 * Apply migration 0078 — add users.passwordChangedAt for JWT session
 * invalidation on password reset. INSTANT DDL, idempotent.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0078-password-changed-at.mjs
 *   railway run --service WORKER node tooling/apply-0078-password-changed-at.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function snapshot() {
  const [rows] = await conn.query(
    `SELECT column_name, column_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'passwordChangedAt'`,
  );
  return rows;
}

console.log("[0078] Pre-state:");
console.table(await snapshot());
await conn.query(readFileSync("drizzle/0078_users_password_changed_at.sql", "utf8"));
console.log("[0078] Post-state:");
console.table(await snapshot());
console.log("[0078] Done.");
await conn.end();

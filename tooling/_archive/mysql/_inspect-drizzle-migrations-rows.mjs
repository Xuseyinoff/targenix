/**
 * Debug helper (read-only): print a few __drizzle_migrations rows.
 * Usage: railway run --service targenix.uz node tooling/mysql/_inspect-drizzle-migrations-rows.mjs
 */
import mysql from "mysql2/promise";

function pickMysqlUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

const url = pickMysqlUrl();
if (!url) {
  console.error("No mysql:// URL in env");
  process.exit(2);
}

const conn = await mysql.createConnection(url);
const [rows] = await conn.query(
  "SELECT id, LEFT(hash, 16) AS hash16, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 10",
);
console.log(rows);
await conn.end();


/**
 * Debug helper (read-only): print __drizzle_migrations columns.
 * Usage: railway run --service targenix.uz node tooling/mysql/_inspect-drizzle-migrations.mjs
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
const [cols] = await conn.query(
  "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '__drizzle_migrations' ORDER BY ORDINAL_POSITION",
);
console.log(cols);
await conn.end();


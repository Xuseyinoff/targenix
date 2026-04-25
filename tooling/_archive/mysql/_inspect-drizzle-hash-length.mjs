/**
 * Debug helper: show hash lengths in __drizzle_migrations.
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
if (!url) process.exit(2);
const conn = await mysql.createConnection(url);
const [rows] = await conn.query(
  "SELECT id, CHAR_LENGTH(hash) AS len, LEFT(hash, 32) AS head FROM __drizzle_migrations ORDER BY id DESC LIMIT 5",
);
console.log(rows);
await conn.end();


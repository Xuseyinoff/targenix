import "dotenv/config";
import mysql from "mysql2/promise";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

if (!url) { console.error("No DB URL found"); process.exit(1); }

const conn = await mysql.createConnection(url);

const [[conns]]  = await conn.execute(`SHOW TABLES LIKE 'connections'`);
const [[col]]    = await conn.execute(`SHOW COLUMNS FROM target_websites LIKE 'connectionId'`);
const [[cnt]]    = await conn.execute(`SELECT COUNT(*) AS n FROM target_websites WHERE connectionId IS NOT NULL`);
const [[fkConn]] = await conn.execute(`
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'connections'
    AND COLUMN_NAME = 'googleAccountId'
    AND REFERENCED_TABLE_NAME = 'google_accounts'`);
const [[fkTw]]   = await conn.execute(`
  SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'target_websites'
    AND COLUMN_NAME = 'connectionId'
    AND REFERENCED_TABLE_NAME = 'connections'`);

console.log("");
console.log("=== Migration 0043 verification ===");
console.log("connections table exists            :", conns  ? "YES ✅" : "NO ❌");
console.log("target_websites.connectionId exists :", col    ? "YES ✅" : "NO ❌");
console.log("rows with non-null connectionId     :", cnt?.n ?? 0, "(expected: 0)");
console.log("FK connections->google_accounts     :", fkConn?.CONSTRAINT_NAME ?? "NOT FOUND ❌");
console.log("FK target_websites->connections     :", fkTw?.CONSTRAINT_NAME   ?? "NOT FOUND ❌");
console.log("");

await conn.end();

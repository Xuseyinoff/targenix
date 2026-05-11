/**
 * Manual apply of 0065_connection_events (creates a new table).
 * Mirrors apply-migration-0064 — drift-safe and idempotent.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import * as fs from "fs";
import * as crypto from "crypto";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL;
  if (!dbUrl) throw new Error("DATABASE_URL / MYSQL_PUBLIC_URL / MYSQL_URL not set");
  const sql = fs.readFileSync("drizzle/0065_connection_events.sql", "utf8");
  const conn = await mysql.createConnection(dbUrl);

  // Idempotency: skip if table exists
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_events'"
  );
  if (rows.length > 0) {
    console.log("[0065] Already applied — connection_events table exists.");
    await conn.end();
    return;
  }

  const cleanSql = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();
  console.log("[0065] Creating connection_events table...");
  await conn.query(cleanSql);

  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  const ts = 1778538000000;
  await conn.query(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    [hash, ts]
  );
  console.log(`[0065] Recorded migration hash=${hash.slice(0, 12)}...`);
  console.log("[0065] Done.");
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

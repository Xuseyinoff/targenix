/**
 * Apply migration 0084 — add telegram_pending_chats.claimedByUserId (+ index).
 * MySQL 8 InnoDB ADD COLUMN (nullable, no default) is INSTANT DDL. Idempotent.
 * Prints the column/index state before and after so the change is visible.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0084-telegram-pending-claimed-by.mjs
 *   railway run --service targenix.uz node tooling/apply-0084-telegram-pending-claimed-by.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function describe() {
  const [cols] = await conn.query(
    `SELECT column_name, column_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'telegram_pending_chats'
        AND column_name = 'claimedByUserId'`,
  );
  const [idx] = await conn.query(
    `SELECT index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'telegram_pending_chats'
        AND index_name = 'idx_telegram_pending_chats_claimed_by'`,
  );
  return { column: cols, index: idx };
}

console.log("[0084] BEFORE:");
console.table((await describe()).column);

await conn.query(readFileSync("drizzle/0084_telegram_pending_chats_claimed_by.sql", "utf8"));

const after = await describe();
console.log("\n[0084] AFTER — column:");
console.table(after.column);
console.log(`[0084] AFTER — index present: ${after.index.length > 0 ? "yes" : "no"}`);

console.log("\n[0084] Done.");
await conn.end();

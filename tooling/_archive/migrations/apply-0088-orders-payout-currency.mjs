/**
 * Apply migration 0088 — add orders.payoutCurrency (Phase 3).
 *
 * Pairs with orders.payoutAmount (0085). MySQL 8 ADD COLUMN with constant
 * default is INSTANT DDL. Idempotent.
 *
 * Usage:
 *   railway run node tooling/apply-0088-orders-payout-currency.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url) {
  console.error("No DB URL set");
  process.exit(1);
}
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function describe() {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'orders'
        AND column_name IN ('payoutAmount', 'payoutCurrency')
      ORDER BY column_name`,
  );
  return cols;
}

console.log("[0088] BEFORE:");
console.table(await describe());

await conn.query(readFileSync("drizzle/0088_orders_payout_currency.sql", "utf8"));

console.log("\n[0088] AFTER:");
console.table(await describe());

console.log("\n[0088] Done.");
await conn.end();

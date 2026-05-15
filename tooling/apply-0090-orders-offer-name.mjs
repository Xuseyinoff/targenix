/**
 * Apply migration 0090 — add orders.offerName.
 * INSTANT DDL on MySQL 8 InnoDB. Idempotent.
 *
 * Usage:
 *   railway run node tooling/apply-0090-orders-offer-name.mjs
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
  const [r] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'orders'
        AND column_name = 'offerName'`,
  );
  return r[0] ?? null;
}

console.log("[0090] BEFORE:");
console.table([await describe()]);

await conn.query(readFileSync("drizzle/0090_orders_offer_name.sql", "utf8"));

console.log("\n[0090] AFTER:");
console.table([await describe()]);

console.log("\n[0090] Done.");
await conn.end();

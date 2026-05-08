/**
 * Migration: add Phase 10 observability columns to the orders table.
 *
 * Safe to run multiple times — uses IF NOT EXISTS checks.
 * All columns are NULL-able; existing rows are unaffected.
 *
 * New columns:
 *   errorType  VARCHAR(32)  — delivery error classification (network/validation/…)
 *   durationMs INT          — end-to-end delivery latency in ms
 *   adapterKey VARCHAR(64)  — which adapter handled the delivery
 *
 * Usage:
 *   node tooling/mysql/add-orders-observability-cols.mjs
 *   railway run node tooling/mysql/add-orders-observability-cols.mjs
 */

import mysql from "mysql2/promise";
import "dotenv/config";

const db = await mysql.createConnection(process.env.DATABASE_URL);

const [cols] = await db.execute(`
  SELECT COLUMN_NAME
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME IN ('errorType', 'durationMs', 'adapterKey')
`);
const existing = new Set(cols.map((r) => r.COLUMN_NAME));

const toAdd = [];
if (!existing.has("errorType"))  toAdd.push("ADD COLUMN errorType  VARCHAR(32) NULL AFTER responseData");
if (!existing.has("durationMs")) toAdd.push("ADD COLUMN durationMs INT         NULL AFTER errorType");
if (!existing.has("adapterKey")) toAdd.push("ADD COLUMN adapterKey VARCHAR(64) NULL AFTER durationMs");

if (toAdd.length === 0) {
  console.log("✅ observability columns already exist — nothing to do");
} else {
  await db.execute(`ALTER TABLE orders ${toAdd.join(", ")}`);
  console.log(`✅ added columns: ${toAdd.map((s) => s.split("COLUMN ")[1].split(" ")[0]).join(", ")}`);
}

await db.end();

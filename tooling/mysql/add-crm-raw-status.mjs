/**
 * Migration: orders.crmRawStatus column
 *
 * Stores the original status string from the CRM platform before normalization.
 * Example: Sotuvchi "client_returned" → crmRawStatus="client_returned", crmStatus="cancelled"
 *
 * Usage: railway run --service MySQL node tooling/mysql/add-crm-raw-status.mjs
 */
import mysql from "mysql2/promise";

const urls = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL].filter(Boolean);
let cn;
for (const u of urls) { try { cn = await mysql.createConnection(u); break; } catch {} }
if (!cn) { console.error("No DB reachable"); process.exit(1); }

// 1. Add column (idempotent)
try {
  await cn.query(
    "ALTER TABLE orders ADD COLUMN crmRawStatus VARCHAR(64) NULL AFTER crmStatus"
  );
  console.log("✓ Column crmRawStatus added");
} catch (e) {
  if (e.code === "ER_DUP_FIELDNAME") {
    console.log("⚠ Column crmRawStatus already exists — skipping ALTER");
  } else {
    throw e;
  }
}

// 2. Stats
const [[{ withRaw, total }]] = await cn.query(`
  SELECT
    COUNT(CASE WHEN crmRawStatus IS NOT NULL THEN 1 END) as withRaw,
    COUNT(*) as total
  FROM orders
  WHERE status = 'SENT' AND crmStatus IS NOT NULL
`);
console.log(`\nSENT orders with crmStatus: ${total}`);
console.log(`  already have crmRawStatus: ${withRaw}`);
console.log(`  will be filled on next sync: ${total - withRaw}`);

await cn.end();
console.log("\nMigration tugadi ✓");

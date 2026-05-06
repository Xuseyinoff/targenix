/**
 * Migration: orders.isFinal column
 *
 * 1. ALTER TABLE orders ADD COLUMN isFinal BOOLEAN DEFAULT FALSE NOT NULL
 * 2. Backfill: mark existing orders whose crmStatus is terminal
 *
 * Usage: railway run --service MySQL node tooling/mysql/add-is-final-column.mjs
 */
import mysql from "mysql2/promise";

const FINAL_STATUSES = [
  "delivered", "not_delivered", "cancelled",
  "client_returned", "trash", "not_sold", "not_sold_group", "archived",
];

const urls = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL].filter(Boolean);
let cn;
for (const u of urls) { try { cn = await mysql.createConnection(u); break; } catch {} }
if (!cn) { console.error("No DB reachable"); process.exit(1); }

// 1. Add column (idempotent)
try {
  await cn.query("ALTER TABLE orders ADD COLUMN isFinal BOOLEAN NOT NULL DEFAULT FALSE");
  console.log("✓ Column isFinal added");
} catch (e) {
  if (e.code === "ER_DUP_FIELDNAME") {
    console.log("⚠ Column isFinal already exists — skipping ALTER");
  } else {
    throw e;
  }
}

// 2. Backfill existing terminal orders
const placeholders = FINAL_STATUSES.map(() => "?").join(", ");
const [result] = await cn.query(
  `UPDATE orders SET isFinal = TRUE WHERE crmStatus IN (${placeholders}) AND isFinal = FALSE`,
  FINAL_STATUSES,
);
console.log(`✓ Backfill: ${result.affectedRows} ta order isFinal=TRUE qilindi`);

// 3. Stats
const [stats] = await cn.query(
  "SELECT isFinal, COUNT(*) as cnt FROM orders WHERE status = 'SENT' GROUP BY isFinal"
);
console.log("\nSENT orders bo'yicha:");
stats.forEach(r => console.log(`  isFinal=${r.isFinal}: ${r.cnt} ta`));

await cn.end();
console.log("\nMigration tugadi ✓");

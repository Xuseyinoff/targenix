/**
 * Production migration — uses MYSQL_PUBLIC_URL (Railway public endpoint).
 * Run from local machine: railway run node tooling/mysql/add-orders-observability-cols-prod.mjs
 */
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL;
if (!url) { console.error("MYSQL_PUBLIC_URL not set"); process.exit(1); }
console.log("DB:", url.replace(/:\/\/[^@]+@/, "://***@"));

const db = await mysql.createConnection(url);

const [cols] = await db.execute(
  `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
     AND COLUMN_NAME IN ('errorType','durationMs','adapterKey')`
);
const found = new Set(cols.map((r) => r.COLUMN_NAME));
console.log("Existing:", [...found]);

const toAdd = [];
if (!found.has("errorType"))  toAdd.push("ADD COLUMN errorType  VARCHAR(32) NULL AFTER responseData");
if (!found.has("durationMs")) toAdd.push("ADD COLUMN durationMs INT         NULL AFTER errorType");
if (!found.has("adapterKey")) toAdd.push("ADD COLUMN adapterKey VARCHAR(64) NULL AFTER durationMs");

if (toAdd.length === 0) {
  console.log("✅ All columns already exist — nothing to do.");
} else {
  await db.execute(`ALTER TABLE orders ${toAdd.join(", ")}`);
  console.log("✅ Added:", toAdd.map(s => s.split("COLUMN ")[1].split(" ")[0]));
}

await db.end();
process.exit(0);

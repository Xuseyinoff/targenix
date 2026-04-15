import mysql from "mysql2/promise";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

if (!url) { console.error("No DB URL"); process.exit(1); }

const conn = await mysql.createConnection(url);

// Apr 15 18:00-20:00 hozirgi holat
console.log("\n=== Apr 15 18:00-20:00 hozirgi holat ===\n");
const [hourly] = await conn.query(
  `SELECT
     DATE_FORMAT(createdAt, '%Y-%m-%d %H:00') as hour,
     SUM(CASE WHEN dataStatus='PENDING' THEN 1 ELSE 0 END) as pending,
     SUM(CASE WHEN dataStatus='ENRICHED' THEN 1 ELSE 0 END) as enriched,
     SUM(CASE WHEN dataStatus='ERROR' THEN 1 ELSE 0 END) as error_cnt,
     COUNT(*) as total
   FROM leads
   WHERE createdAt >= '2026-04-15 18:00:00'
   GROUP BY DATE_FORMAT(createdAt, '%Y-%m-%d %H:00')
   ORDER BY hour`
);
console.table(hourly);

// Bugun jami PENDING
const [[{ total_pending }]] = await conn.query(
  `SELECT COUNT(*) as total_pending FROM leads
   WHERE DATE(createdAt) = '2026-04-15' AND dataStatus = 'PENDING'`
);
console.log(`\nBugun (Apr 15) jami PENDING: ${total_pending}`);

// Retry scheduler oxirgi necha minutda ishladimi? — leads uchun
// (PENDING > ENRICHED o'zgarish bor edi mi?)
const [recent] = await conn.query(
  `SELECT dataStatus, COUNT(*) as cnt, MAX(updatedAt) as last_update
   FROM leads
   WHERE updatedAt >= NOW() - INTERVAL 10 MINUTE
   GROUP BY dataStatus`
);
console.log("\nOxirgi 10 daqiqa ichida yangilangan leadlar:");
console.table(recent);

await conn.end();

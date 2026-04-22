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

const [[{ total, min_date, max_date }]] = await conn.query(
  `SELECT COUNT(*) as total, MIN(createdAt) as min_date, MAX(createdAt) as max_date
   FROM leads WHERE dataStatus = 'PENDING'`
);
console.log(`Jami PENDING: ${total}`);
console.log(`Diapazon: ${min_date} → ${max_date}`);

// Server UTC vaqti
const [[{ now }]] = await conn.query(`SELECT NOW() as now`);
console.log(`\nDB server vaqti (UTC): ${now}`);

// Keyingi soat boshigacha qancha minut qoldi
const d = new Date(now);
const minLeft = 60 - d.getMinutes();
console.log(`Keyingi scheduler run: ~${minLeft} daqiqadan keyin (soat :00 da)`);

await conn.end();

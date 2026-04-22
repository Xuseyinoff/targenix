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

const DRY_RUN = process.argv[2] !== "--delete";

const [[{ total }]] = await conn.query(
  `SELECT COUNT(*) as total FROM leads
   WHERE dataStatus = 'PENDING'
     AND DATE(createdAt) BETWEEN '2026-04-10' AND '2026-04-13'`
);

const [breakdown] = await conn.query(
  `SELECT DATE(createdAt) as sana, COUNT(*) as cnt
   FROM leads
   WHERE dataStatus = 'PENDING'
     AND DATE(createdAt) BETWEEN '2026-04-10' AND '2026-04-13'
   GROUP BY DATE(createdAt)
   ORDER BY sana`
);

console.log(`\nO'chiriladigan PENDING leadlar (Apr 10-13): ${total}`);
console.table(breakdown);

if (DRY_RUN) {
  console.log("\n⚠️  DRY RUN — haqiqiy o'chirish uchun: --delete flag bilan ishga tushiring");
  await conn.end();
  process.exit(0);
}

const [result] = await conn.query(
  `DELETE FROM leads
   WHERE dataStatus = 'PENDING'
     AND DATE(createdAt) BETWEEN '2026-04-10' AND '2026-04-13'`
);

console.log(`\n✅ O'chirildi: ${result.affectedRows} ta lead`);

await conn.end();

import mysql from "mysql2/promise";

const id = process.argv[2] ?? "1566373468011126";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates.map((u) => u?.trim()).find((u) => u?.startsWith("mysql://"));
if (!url) { console.error("No DB URL"); process.exit(1); }

const conn = await mysql.createConnection(url);

const [rows] = await conn.query(
  "SELECT id, userId, leadgenId, pageId, formId, fullName, phone, dataStatus, deliveryStatus, createdAt FROM leads WHERE leadgenId = ? LIMIT 5",
  [id]
);

if (rows.length === 0) {
  console.log(`leadgenId=${id} — NOT FOUND in DB`);
} else {
  console.log(`leadgenId=${id} — FOUND (${rows.length} row):`);
  console.table(rows);
}

await conn.end();

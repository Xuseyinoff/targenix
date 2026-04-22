import mysql from "mysql2/promise";

// For local scripts, prefer PUBLIC url (internal Railway URL won't resolve outside Railway network)
const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates.map((u) => u?.trim()).find((u) => u?.startsWith("mysql://"));
if (!url) {
  console.error("No DB URL found in environment");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

console.log("\n=== LEAD STATUS BREAKDOWN (all time) ===");
const [breakdown] = await conn.query(
  "SELECT dataStatus, deliveryStatus, COUNT(*) as cnt FROM leads GROUP BY dataStatus, deliveryStatus ORDER BY cnt DESC"
);
console.table(breakdown);

console.log("\n=== PENDING leads in last 24 hours ===");
const [pending24h] = await conn.query(
  "SELECT COUNT(*) as cnt FROM leads WHERE dataStatus = 'PENDING' AND createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)"
);
console.log("Count:", pending24h[0].cnt);

console.log("\n=== PENDING leads (all time) ===");
const [pendingAll] = await conn.query(
  "SELECT COUNT(*) as cnt FROM leads WHERE dataStatus = 'PENDING'"
);
console.log("Count:", pendingAll[0].cnt);

if (Number(pendingAll[0].cnt) > 0) {
  console.log("\n=== Sample PENDING leads (newest 10) ===");
  const [samples] = await conn.query(
    "SELECT id, userId, fullName, phone, dataStatus, deliveryStatus, createdAt FROM leads WHERE dataStatus = 'PENDING' ORDER BY createdAt DESC LIMIT 10"
  );
  console.table(samples);
}

await conn.end();

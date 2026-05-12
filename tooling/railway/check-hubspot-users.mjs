import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL?.trim() ||
  process.env.MYSQL_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!url) {
  console.error("No MySQL URL found (MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL).");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
try {
  const [rows] = await conn.query(
    `SELECT u.id AS userId, u.email, u.name, c.id AS connectionId, c.status, c.createdAt
     FROM connections c
     JOIN users u ON u.id = c.userId
     WHERE c.appKey='hubspot'
     ORDER BY c.createdAt DESC
     LIMIT 50`,
  );
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await conn.end();
}


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
  const [users] = await conn.query(
    "SELECT id,email,name,role,createdAt FROM users ORDER BY id ASC LIMIT 200",
  );
  console.log(JSON.stringify(users, null, 2));
} finally {
  await conn.end();
}


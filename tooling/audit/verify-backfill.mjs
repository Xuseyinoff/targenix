import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection({ uri: url });

const [count] = await conn.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations`");
console.log("Total rows in __drizzle_migrations:", count[0].n);

const [recent] = await conn.query(
  "SELECT id, hash, created_at FROM `__drizzle_migrations` WHERE created_at >= 1779833280005 ORDER BY created_at"
);
console.log("\nNewly added rows (created_at >= 1779833280005):");
console.table(recent);

await conn.end();

import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const [rows] = await conn.query("SELECT * FROM __drizzle_migrations ORDER BY id DESC LIMIT 10");
  console.log("Applied migrations:", rows);
  await conn.end();
}
main().catch(console.error);

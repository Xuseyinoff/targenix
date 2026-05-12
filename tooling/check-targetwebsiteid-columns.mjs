import "dotenv/config";
import mysql from "mysql2/promise";
const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL });
const [rows] = await conn.query(
  `SELECT table_name, column_name, column_type, is_nullable
     FROM information_schema.columns
    WHERE table_schema = DATABASE() AND column_name = 'targetWebsiteId'`,
);
console.log(rows);
await conn.end();

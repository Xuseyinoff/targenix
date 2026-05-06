/**
 * templateId NULL bo'lgan target_websites ro'yxati (read-only).
 */
import "dotenv/config";
import mysql from "mysql2/promise";
const url =
  process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const c = await mysql.createConnection({ uri: url });
const [rows] = await c.query(
  `SELECT id, userId, name, url, connectionId, templateId, isActive, templateType
     FROM target_websites
    WHERE templateId IS NULL
    ORDER BY id`,
);
const [[{ n }]] = await c.query(
  `SELECT COUNT(*) AS n FROM target_websites WHERE templateId IS NULL`,
);
console.log(JSON.stringify({ countNoTemplate: n, rows }, null, 2));
await c.end();

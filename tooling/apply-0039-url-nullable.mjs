/**
 * Apply 0039_telegram_destination.sql on Railway when migrate did not run it.
 * Usage: railway run node tooling/apply-0039-url-nullable.mjs
 */
import mysql from "mysql2/promise";

function pickMysqlUrl() {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
  ];
  for (const [k, v] of Object.entries(process.env)) {
    const name = k.replace(/\r/g, "").trim();
    if (
      (name === "MYSQL_PUBLIC_URL" || name === "MYSQL_URL") &&
      typeof v === "string" &&
      v.trim().startsWith("mysql://")
    ) {
      candidates.push(v.trim());
    }
  }
  return candidates.find((u) => typeof u === "string" && u.startsWith("mysql://"));
}

const url = pickMysqlUrl();
if (!url) {
  console.error("No database URL");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
try {
  await conn.query(
    "ALTER TABLE `target_websites` MODIFY COLUMN `url` text NULL"
  );
  console.log("ALTER applied: target_websites.url is now nullable.");
  const [rows] = await conn.query(
    "SHOW COLUMNS FROM target_websites LIKE 'url'"
  );
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await conn.end();
}

/**
 * Extends crm_connections.phone from VARCHAR(32) to VARCHAR(64)
 * to accommodate email addresses (Sotuvchi uses email login).
 * Usage: railway run node tooling/mysql/fix-crm-phone-length.mjs
 */
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_URL ??
  process.env.MYSQL_PUBLIC_URL ??
  process.env.DATABASE_URL;

if (!url) {
  console.error("No MySQL URL env var found");
  process.exit(1);
}

const cn = await mysql.createConnection(url);

try {
  // Check current length
  const [cols] = await cn.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'crm_connections' AND COLUMN_NAME = 'phone'`
  );
  const current = cols[0]?.CHARACTER_MAXIMUM_LENGTH;
  console.log(`Current phone column length: ${current}`);

  if (current >= 64) {
    console.log("Already 64+ chars — no change needed.");
  } else {
    await cn.query(
      `ALTER TABLE crm_connections MODIFY COLUMN phone VARCHAR(64) NOT NULL`
    );
    console.log("Done: phone column extended to VARCHAR(64).");
  }
} finally {
  await cn.end();
}

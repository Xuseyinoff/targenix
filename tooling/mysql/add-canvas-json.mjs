/**
 * add-canvas-json.mjs
 * Adds canvasJson JSON column to workflows table.
 * Usage: MYSQL_URL="mysql://..." node tooling/mysql/add-canvas-json.mjs
 */
import mysql from "mysql2/promise";

const url = process.env.MYSQL_URL;
if (!url) { console.error("MYSQL_URL required"); process.exit(1); }

const conn = await mysql.createConnection(url);

const [[row]] = await conn.query(
  `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflows' AND COLUMN_NAME = 'canvasJson'`
);

if (row.cnt > 0) {
  console.log("✓ canvasJson column already exists");
} else {
  await conn.query(`ALTER TABLE workflows ADD COLUMN canvasJson JSON NULL AFTER isActive`);
  console.log("✓ canvasJson column added to workflows");
}

await conn.end();
console.log("Migration complete.");

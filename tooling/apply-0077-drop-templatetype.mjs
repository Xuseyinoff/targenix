/**
 * Apply migration 0077 — drop the legacy destinations.templateType column.
 * MySQL 8 InnoDB ALTER TABLE DROP COLUMN is INSTANT DDL. Idempotent.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0077-drop-templatetype.mjs
 *   railway run --service WORKER node tooling/apply-0077-drop-templatetype.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function snapshot() {
  const [rows] = await conn.query(
    `SELECT column_name, column_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'destinations'
        AND column_name IN ('templateType','appKey')
      ORDER BY column_name`,
  );
  return rows;
}

console.log("[0077] Pre-state:");
console.table(await snapshot());
await conn.query(readFileSync("drizzle/0077_drop_templatetype_column.sql", "utf8"));
console.log("[0077] Post-state:");
console.table(await snapshot());
console.log("[0077] Done.");
await conn.end();

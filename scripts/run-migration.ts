/**
 * scripts/run-migration.ts
 * Runs 0001_leads_denormalize.sql against the configured database.
 * Usage: railway run npx tsx scripts/run-migration.ts
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url =
  process.env.MYSQL_PUBLIC_URL?.startsWith("mysql://") ? process.env.MYSQL_PUBLIC_URL :
  process.env.MYSQL_URL?.startsWith("mysql://")        ? process.env.MYSQL_URL :
  process.env.DATABASE_URL;

if (!url) {
  console.error("No DB URL found. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
  process.exit(1);
}

const sqlPath = join(__dirname, "../drizzle/migrations/0001_leads_denormalize.sql");
const rawSql = readFileSync(sqlPath, "utf8");

// Split on semicolons, skip comments and empty lines
const statements = rawSql
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith("--"));

const connection = await mysql.createConnection(url);

console.log(`[Migration] Connected. Running ${statements.length} statement(s)...`);

for (const stmt of statements) {
  const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
  try {
    await connection.execute(stmt);
    console.log(`[Migration] ✓ ${preview}`);
  } catch (err: any) {
    // Column/index already exists — safe to skip
    if (err.code === "ER_DUP_FIELDNAME" || err.code === "ER_DUP_KEYNAME" || err.errno === 1060 || err.errno === 1061) {
      console.log(`[Migration] ⚠ Already exists, skipping: ${preview}`);
    } else {
      console.error(`[Migration] ✗ FAILED: ${preview}`);
      console.error(err.message);
      await connection.end();
      process.exit(1);
    }
  }
}

await connection.end();
console.log("[Migration] Done.");

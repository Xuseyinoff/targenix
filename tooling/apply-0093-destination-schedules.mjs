/**
 * Apply migration 0093 — create destination_schedules + destination_pending_leads.
 *
 * Yuboraman parity sprint, PR 4/4 Phase A. The SQL file is fully idempotent
 * (CREATE TABLE IF NOT EXISTS for both tables; the indexes are declared
 * inline). This script also backfills the `__drizzle_migrations` row keyed
 * on sha256(0093_*.sql) so drizzle-kit migrate won't try to re-run.
 *
 * Usage:
 *   railway run --service=targenix.uz node tooling/apply-0093-destination-schedules.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const SQL_FILE = "drizzle/0093_destination_schedules.sql";
const TABLES = ["destination_schedules", "destination_pending_leads"];

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[apply-0093] No mysql:// URL in env. Set MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL.");
  process.exit(1);
}

console.log("[apply-0093] Connecting to:", url.replace(/:\/\/[^@]+@/, "://<hidden>@"));
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function tableExists(name) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return rows[0].n > 0;
}

async function listIndexes(table) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [table],
  );
  return rows;
}

let exitCode = 0;
try {
  console.log("\n[apply-0093] BEFORE state:");
  for (const t of TABLES) {
    console.log(`  ${t}: ${(await tableExists(t)) ? "EXISTS" : "missing"}`);
  }

  console.log("\n[apply-0093] Applying DDL from", SQL_FILE);
  const sql = readFileSync(SQL_FILE, "utf8");
  await conn.query(sql);
  console.log("[apply-0093] DDL executed OK");

  console.log("\n[apply-0093] AFTER state:");
  for (const t of TABLES) {
    const present = await tableExists(t);
    console.log(`  ${t}: ${present ? "EXISTS" : "MISSING"}`);
    if (!present) exitCode = 1;
  }

  if (exitCode === 0) {
    for (const t of TABLES) {
      console.log(`\n[apply-0093] ${t} indexes:`);
      console.table(await listIndexes(t));
    }
  } else {
    console.error("[apply-0093] ERROR — one or more expected tables missing after apply.");
  }

  // Backfill __drizzle_migrations row keyed by sha256(sql).
  const hash = crypto.createHash("sha256").update(readFileSync(SQL_FILE)).digest("hex");
  const [existing] = await conn.query(
    "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
    [hash],
  );
  if (existing.length > 0) {
    console.log(`\n[apply-0093] __drizzle_migrations row already present (id=${existing[0].id}) — SKIP`);
  } else {
    const when = Date.now();
    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [hash, when],
    );
    console.log(`\n[apply-0093] Inserted __drizzle_migrations row — hash=${hash.slice(0, 12)}… when=${when}`);
  }
} catch (err) {
  console.error("[apply-0093] FATAL:", err.message);
  exitCode = 1;
} finally {
  await conn.end();
}

console.log(exitCode === 0 ? "\n[apply-0093] Done." : "\n[apply-0093] FAILED.");
process.exit(exitCode);

/**
 * One-off repair: prod DB already has app_actions schema columns, but Drizzle
 * migration 0063 fails (duplicate column). This script:
 *   1) Adds any missing columns individually (safe / idempotent)
 *   2) Records the migration hash in __drizzle_migrations so drizzle-kit skips it
 *
 * Usage:
 *   railway run node tooling/drizzle/repair-0063-app-actions-action-schema.mjs
 *   # then:
 *   railway run pnpm exec drizzle-kit migrate
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const MIGRATION_FILE = "drizzle/0063_app_actions_action_schema.sql";
/** Must match drizzle/meta/_journal.json entry for 0063 */
const MIGRATION_CREATED_AT = 1778182800000;

function getMysqlUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

function fileHash() {
  return createHash("sha256")
    .update(readFileSync(join(ROOT, MIGRATION_FILE)))
    .digest("hex");
}

async function ensureColumn(conn, name, alterSql) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'app_actions'
       AND COLUMN_NAME = ?`,
    [name],
  );
  if (Number(row.c) > 0) {
    console.log(`[repair-0063] app_actions.${name}: already exists`);
    return;
  }
  await conn.query(alterSql);
  console.log(`[repair-0063] app_actions.${name}: added`);
}

async function main() {
  const url = getMysqlUrl();
  if (!url) {
    console.error("Need MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL (mysql://)");
    process.exit(1);
  }
  const h = fileHash();
  const conn = await mysql.createConnection(url);
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
        \`id\` serial primary key,
        \`hash\` text not null,
        \`created_at\` bigint
      )
    `);

    const [[already]] = await conn.query(
      "SELECT 1 AS ok FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
      [h],
    );
    if (already) {
      console.log("[repair-0063] Migration 0063 already recorded (hash matches). OK.");
      return;
    }

    await ensureColumn(
      conn,
      "schemaVersion",
      "ALTER TABLE `app_actions` ADD COLUMN `schemaVersion` INT NOT NULL DEFAULT 1",
    );
    await ensureColumn(
      conn,
      "inputSchema",
      "ALTER TABLE `app_actions` ADD COLUMN `inputSchema` JSON NULL",
    );
    await ensureColumn(
      conn,
      "outputSchema",
      "ALTER TABLE `app_actions` ADD COLUMN `outputSchema` JSON NULL",
    );
    await ensureColumn(
      conn,
      "uiSchema",
      "ALTER TABLE `app_actions` ADD COLUMN `uiSchema` JSON NULL",
    );

    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [h, MIGRATION_CREATED_AT],
    );
    console.log("[repair-0063] Recorded in __drizzle_migrations. Hash:", h.slice(0, 16) + "…");
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


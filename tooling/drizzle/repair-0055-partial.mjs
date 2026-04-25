/**
 * One-off repair: first `drizzle-kit migrate` run may have created `oauth_states` /
 * `oauth_tokens` then failed on multi-statement `ALTER` (MySQL). This finishes
 * `connections` columns, backfill, journal row, idempotently.
 *
 *   railway run node tooling/drizzle/repair-0055-partial.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const MIGRATION_FILE = "drizzle/0055_oauth_tokens_universal.sql";
/** Must match `drizzle/meta/_journal.json` entry for 0055 */
const MIGRATION_CREATED_AT = 1777833600000;

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

async function main() {
  const url = getMysqlUrl();
  if (!url) {
    console.error("Need MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL (mysql://)");
    process.exit(1);
  }
  const h = fileHash();
  const conn = await mysql.createConnection(url);
  try {
    const [[already]] = await conn.query(
      "SELECT 1 AS ok FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
      [h],
    );
    if (already) {
      console.log("[repair-0055] Migration 0055 already recorded (hash matches). OK.");
      return;
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`oauth_states\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`state\` VARCHAR(128) NOT NULL,
        \`userId\` INT NOT NULL,
        \`provider\` VARCHAR(32) NOT NULL,
        \`mode\` VARCHAR(32) NOT NULL,
        \`appKey\` VARCHAR(64) NULL,
        \`expiresAt\` TIMESTAMP NOT NULL,
        \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_oauth_states_state\` (\`state\`),
        KEY \`idx_oauth_states_user\` (\`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("[repair-0055] oauth_states: OK");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`oauth_tokens\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`userId\` INT NOT NULL,
        \`appKey\` VARCHAR(64) NOT NULL,
        \`email\` VARCHAR(320) NOT NULL,
        \`name\` VARCHAR(255) NULL,
        \`picture\` VARCHAR(512) NULL,
        \`accessToken\` TEXT NOT NULL,
        \`refreshToken\` TEXT NULL,
        \`expiryDate\` TIMESTAMP NULL,
        \`scopes\` TEXT NULL,
        \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_oauth_tokens_user_app_email\` (\`userId\`, \`appKey\`, \`email\`),
        KEY \`idx_oauth_tokens_user_app\` (\`userId\`, \`appKey\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("[repair-0055] oauth_tokens: OK");

    const [[cCol]] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connections' AND COLUMN_NAME = 'oauthTokenId'`,
    );
    if (Number(cCol.c) === 0) {
      await conn.query("ALTER TABLE `connections` ADD COLUMN `oauthTokenId` INT NULL");
      console.log("[repair-0055] Added connections.oauthTokenId");
    }

    const [[cIdx]] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connections'
         AND INDEX_NAME = 'idx_connections_oauth_token_id'`,
    );
    if (Number(cIdx.c) === 0) {
      await conn.query(
        "ALTER TABLE `connections` ADD KEY `idx_connections_oauth_token_id` (`oauthTokenId`)",
      );
      console.log("[repair-0055] Added idx_connections_oauth_token_id");
    }

    const [ins] = await conn.query(`
      INSERT INTO \`oauth_tokens\` (
        \`id\`, \`userId\`, \`appKey\`, \`email\`, \`name\`, \`picture\`, \`accessToken\`, \`refreshToken\`, \`expiryDate\`, \`scopes\`, \`createdAt\`
      )
      SELECT
        g.\`id\`,
        g.\`userId\`,
        'google-sheets' AS \`appKey\`,
        g.\`email\`,
        g.\`name\`,
        g.\`picture\`,
        g.\`accessToken\`,
        g.\`refreshToken\`,
        g.\`expiryDate\`,
        g.\`scopes\`,
        g.\`connectedAt\`
      FROM \`google_accounts\` g
      WHERE g.\`type\` = 'integration'
        AND NOT EXISTS (SELECT 1 FROM \`oauth_tokens\` t WHERE t.\`id\` = g.\`id\`)
    `);
    console.log("[repair-0055] Backfill oauth_tokens, affected rows:", ins.affectedRows ?? 0);

    const [up] = await conn.query(`
      UPDATE \`connections\` c
      INNER JOIN \`google_accounts\` g ON c.\`googleAccountId\` = g.\`id\` AND g.\`type\` = 'integration'
      INNER JOIN \`oauth_tokens\` t
        ON t.\`userId\` = g.\`userId\`
        AND t.\`appKey\` = 'google-sheets'
        AND BINARY t.\`email\` = BINARY g.\`email\`
      SET c.\`oauthTokenId\` = t.\`id\`
      WHERE c.\`type\` = 'google_sheets' AND c.\`oauthTokenId\` IS NULL
    `);
    console.log("[repair-0055] Update connections.oauthTokenId, affected rows:", up.affectedRows ?? 0);

    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [h, MIGRATION_CREATED_AT],
    );
    console.log("[repair-0055] Recorded in __drizzle_migrations. Hash:", h.slice(0, 16) + "…");
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * apply-0054.mjs — Drop legacy `connection_app_specs` table.
 *
 * Usage (Railway):
 *   railway run --service targenix.uz node tooling/mysql/apply-0054.mjs audit
 *   railway run --service targenix.uz node tooling/mysql/apply-0054.mjs apply
 *   railway run --service targenix.uz node tooling/mysql/apply-0054.mjs verify
 *   railway run --service targenix.uz node tooling/mysql/apply-0054.mjs rollback
 *
 * PREREQ before apply:
 *   railway run --service targenix.uz node tooling/mysql/audit-connection-app-specs-drop.mjs
 *   Expect: { coverageOk: true, requiredMissing: [] }
 *
 * Rollback:
 *   CREATE TABLE `connection_app_specs` (
 *     `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
 *     `appKey` VARCHAR(64) NOT NULL,
 *     `displayName` VARCHAR(128) NOT NULL,
 *     `authType` ENUM('api_key','oauth2','bearer','none') NOT NULL,
 *     `category` VARCHAR(32) NOT NULL DEFAULT 'affiliate',
 *     `fields` JSON NOT NULL,
 *     `iconUrl` VARCHAR(512) DEFAULT NULL,
 *     `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 *     UNIQUE KEY `uq_connection_app_specs_appKey` (`appKey`)
 *   );
 *   -- Then INSERT rows from backup_connection_app_specs.json
 */

import mysql from "mysql2/promise";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const SQL_FILE = path.join(ROOT, "drizzle/0054_drop_connection_app_specs.sql");
const EXPECTED_HASH = "e021c43f9e8435b080cbd7f32f7ffd26a8dd547ac8f03270ef05584511641f4e";
const CREATED_AT = 1777488003000;

function hashFile(p) {
  const content = fs.readFileSync(p, "utf8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function pickMysqlUrl() {
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

function getConn() {
  const url = pickMysqlUrl();
  if (!url) throw new Error("No mysql:// URL in env (MYSQL_PUBLIC_URL/MYSQL_URL/DATABASE_URL)");
  return mysql.createConnection(url);
}

async function audit() {
  console.log("=== AUDIT 0054 ===");

  const hash = hashFile(SQL_FILE);
  if (hash !== EXPECTED_HASH) {
    console.error(`FAIL: SQL file hash mismatch. Expected ${EXPECTED_HASH}, got ${hash}`);
    process.exit(1);
  }
  console.log(`SQL hash OK (${hash})`);

  const conn = await getConn();
  try {
    const [rows] = await conn.execute(
      "SELECT id, LEFT(hash, 16) AS hash16, created_at FROM __drizzle_migrations WHERE hash = ? LIMIT 1",
      [hash],
    );
    if (Array.isArray(rows) && rows.length > 0) {
      console.log("0054 already applied — nothing to do.");
    } else {
      console.log("0054 NOT yet applied — ready to apply.");
    }

    const [tables] = await conn.execute(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_app_specs'",
    );
    if (tables.length > 0) {
      console.log("connection_app_specs table EXISTS (expected before drop).");
    } else {
      console.log("connection_app_specs table does NOT exist (already dropped or never created).");
    }

    const [appRows] = await conn.execute("SELECT COUNT(*) AS cnt FROM apps WHERE isActive = 1");
    console.log(`apps table active rows: ${appRows[0].cnt}`);
  } finally {
    await conn.end();
  }
}

async function apply() {
  console.log("=== APPLY 0054 ===");

  const hash = hashFile(SQL_FILE);
  if (hash !== EXPECTED_HASH) {
    console.error(`ABORT: SQL file hash mismatch. Expected ${EXPECTED_HASH}, got ${hash}`);
    process.exit(1);
  }

  const conn = await getConn();
  try {
    const [existing] = await conn.execute(
      "SELECT id FROM __drizzle_migrations WHERE hash = ? LIMIT 1",
      [hash],
    );
    if (Array.isArray(existing) && existing.length > 0) {
      console.log("0054 already applied. Skipping.");
      return;
    }

    console.log("Dropping connection_app_specs...");
    await conn.execute("DROP TABLE IF EXISTS `connection_app_specs`");
    console.log("Done.");

    await conn.execute(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      [hash, CREATED_AT],
    );
    console.log("Migration recorded in __drizzle_migrations.");
    console.log("0054 applied successfully.");
  } finally {
    await conn.end();
  }
}

async function verify() {
  console.log("=== VERIFY 0054 ===");
  const conn = await getConn();
  try {
    const [tables] = await conn.execute(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_app_specs'",
    );
    if (tables.length > 0) {
      console.error("FAIL: connection_app_specs still exists.");
      process.exit(1);
    }
    console.log("OK: connection_app_specs does not exist.");

    const [migRow] = await conn.execute(
      "SELECT id FROM __drizzle_migrations WHERE hash = ? LIMIT 1",
      [EXPECTED_HASH],
    );
    if (!Array.isArray(migRow) || migRow.length === 0) {
      console.error("FAIL: migration not recorded in __drizzle_migrations.");
      process.exit(1);
    }
    console.log("OK: migration recorded.");
    console.log("VERIFY PASSED.");
  } finally {
    await conn.end();
  }
}

async function rollback() {
  console.log("=== ROLLBACK 0054 ===");
  const conn = await getConn();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS \`connection_app_specs\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`appKey\` VARCHAR(64) NOT NULL,
        \`displayName\` VARCHAR(128) NOT NULL,
        \`authType\` ENUM('api_key','oauth2','bearer','basic','none') NOT NULL,
        \`category\` VARCHAR(32) NOT NULL DEFAULT 'affiliate',
        \`fields\` JSON NOT NULL,
        \`iconUrl\` VARCHAR(512) DEFAULT NULL,
        \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`uq_connection_app_specs_appKey\` (\`appKey\`)
      )
    `);
    console.log("connection_app_specs recreated.");
    console.log("NOTE: Rows not restored — insert from backup_connection_app_specs.json if needed.");

    await conn.execute(
      "DELETE FROM __drizzle_migrations WHERE hash = ?",
      [EXPECTED_HASH],
    );
    console.log("Migration entry removed from __drizzle_migrations.");
    console.log("ROLLBACK COMPLETE.");
  } finally {
    await conn.end();
  }
}

const cmd = process.argv[2];
switch (cmd) {
  case "audit":    await audit();    break;
  case "apply":    await apply();    break;
  case "verify":   await verify();   break;
  case "rollback": await rollback(); break;
  default:
    console.error("Usage: node apply-0054.mjs <audit|apply|verify|rollback>");
    process.exit(1);
}

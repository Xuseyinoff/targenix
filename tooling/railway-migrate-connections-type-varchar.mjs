/**
 * connections.type: ENUM → VARCHAR(32) — audit, backup, ALTER, verify.
 * Run: railway run --service targenix.uz node tooling/railway-migrate-connections-type-varchar.mjs
 *
 * Backup path uses os.tmpdir() — works on Railway Linux and local Windows `railway run`.
 */
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import mysql from "mysql2/promise";

const BACKUP_PATH = path.join(tmpdir(), "backup_connections_type.json");
const ALLOWED = new Set(["google_sheets", "telegram_bot", "api_key"]);

function resolveDatabaseUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const url = raw?.trim().replace(/^=+/, "");
    if (url && url.startsWith("mysql://")) return url;
  }
  return process.env.DATABASE_URL?.trim().replace(/^=+/, "");
}

function logRollback(reason) {
  console.error(JSON.stringify({ stage: "ROLLBACK_EXECUTED", reason, at: new Date().toISOString() }));
}

async function main() {
  const url = resolveDatabaseUrl();
  if (!url?.startsWith("mysql://")) {
    console.error("STOP: No mysql:// URL");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url, charset: "utf8mb4" });
  await conn.query("SELECT 1");

  const report = { auditTypes: [], backupPath: null, backupRows: 0, alter: null, infoSchema: null, nullCount: null };

  try {
    const [groups] = await conn.query(
      "SELECT `type`, COUNT(*) AS `count` FROM `connections` GROUP BY `type` ORDER BY `type`",
    );
    report.auditTypes = groups;
    console.log("=== STEP 2 — AUDIT (GROUP BY type) ===");
    console.log(JSON.stringify(groups, null, 2));

    for (const row of groups) {
      const t = String(row.type);
      if (!ALLOWED.has(t)) {
        logRollback("unexpected_type_value");
        console.error("STOP: unknown type value:", t, "count=", row.count);
        process.exit(2);
      }
    }

    const [allRows] = await conn.query("SELECT * FROM `connections`");
    report.backupRows = allRows.length;
    try {
      fs.writeFileSync(BACKUP_PATH, JSON.stringify(allRows, null, 2), "utf8");
    } catch (e) {
      logRollback("backup_write_failed");
      console.error("STOP: backup failed", e);
      process.exit(3);
    }
    report.backupPath = BACKUP_PATH;
    console.log("=== STEP 3 — BACKUP OK ===", BACKUP_PATH, "rows=", report.backupRows);

    try {
      await conn.query(`
        ALTER TABLE \`connections\`
        MODIFY COLUMN \`type\` VARCHAR(32) NOT NULL
      `);
      report.alter = "OK";
      console.log("=== STEP 4 — ALTER OK ===");
    } catch (e) {
      logRollback("alter_failed");
      console.error("STOP: ALTER failed", e);
      process.exit(4);
    }

    const [cols] = await conn.query(
      `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'connections'
         AND COLUMN_NAME = 'type'
       LIMIT 1`,
    );
    report.infoSchema = cols[0];
    console.log("=== STEP 5 — INFORMATION_SCHEMA ===");
    console.log(JSON.stringify(cols[0], null, 2));

    const ct = String(cols[0]?.COLUMN_TYPE ?? "").toLowerCase();
    if (!ct.startsWith("varchar")) {
      console.error("STOP: unexpected COLUMN_TYPE", cols[0]?.COLUMN_TYPE);
      process.exit(5);
    }
    if (cols[0]?.IS_NULLABLE !== "NO") {
      console.error("STOP: expected IS_NULLABLE=NO", cols[0]?.IS_NULLABLE);
      process.exit(5);
    }

    const [[{ n }]] = await conn.query(
      "SELECT COUNT(*) AS n FROM `connections` WHERE `type` IS NULL OR TRIM(`type`) = ''",
    );
    report.nullCount = Number(n);
    console.log("=== STEP 6 — NULL/empty type count ===", report.nullCount);
    if (report.nullCount !== 0) {
      console.error("STOP: unexpected NULL/empty type");
      process.exit(6);
    }

    console.log("=== MIGRATION STATUS: SUCCESS ===");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  logRollback("top_level");
  console.error(e);
  process.exit(99);
});

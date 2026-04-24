/**
 * Production SRE script: audit → backup → backfill → verify → NOT NULL (phased).
 * Run ONLY via: railway run --service targenix.uz node tooling/railway-enforce-target-websites-appkey.mjs
 *
 * Env: MYSQL_PUBLIC_URL | MYSQL_URL | DATABASE_URL (mysql://)
 */
import fs from "node:fs";
import mysql from "mysql2/promise";

const BACKUP_PATH = "/tmp/backup_target_websites_appkey.json";

function resolveDatabaseUrl() {
  const candidates = [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ];
  for (const raw of candidates) {
    const url = raw?.trim().replace(/^=+/, "");
    if (url && url.startsWith("mysql://")) return url;
  }
  return process.env.DATABASE_URL?.trim().replace(/^=+/, "");
}

function logRollback(reason) {
  console.error(JSON.stringify({ stage: "ROLLBACK_EXECUTED", reason, at: new Date().toISOString() }));
}

async function getColumnNullable(conn) {
  const [rows] = await conn.query(
    `SELECT IS_NULLABLE AS nullable, COLUMN_DEFAULT AS colDefault
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'target_websites'
       AND COLUMN_NAME = 'appKey'
     LIMIT 1`,
  );
  return rows?.[0] ?? null;
}

async function main() {
  const url = resolveDatabaseUrl();
  if (!url || !url.startsWith("mysql://")) {
    console.error("STOP: No mysql:// connection URL in env.");
    process.exit(1);
  }

  const conn = await mysql.createConnection({ uri: url, charset: "utf8mb4" });
  await conn.query("SELECT 1");

  const report = {
    audit: null,
    backupPath: null,
    backupRowCount: 0,
    rowsUpdated: {},
    remainingNullAfterBackfill: null,
    columnBefore: null,
    columnAfter: null,
    rollback: null,
  };

  try {
    // ── STEP 2 — AUDIT ─────────────────────────────────────────────────────
    const [auditRows] = await conn.query(`
      SELECT
        COUNT(*) AS total,
        SUM(\`appKey\` IS NULL) AS null_appkey,
        SUM(\`templateType\` = 'telegram' AND \`appKey\` IS NULL) AS telegram_missing,
        SUM(\`templateType\` IN ('google-sheets','google_sheets') AND \`appKey\` IS NULL) AS sheets_missing,
        SUM(\`templateId\` IS NOT NULL AND \`appKey\` IS NULL) AS template_missing
      FROM \`target_websites\`
    `);
    report.audit = auditRows[0];
    console.log("=== STEP 2 — AUDIT ===");
    console.log(JSON.stringify(report.audit, null, 2));

    const nullCount = Number(report.audit.null_appkey ?? 0);
    report.columnBefore = await getColumnNullable(conn);

    if (nullCount === 0) {
      console.log("=== SKIP backfill (null_appkey = 0) → STEP 5/6 ===");
    } else {
      // ── STEP 3 — BACKUP ─────────────────────────────────────────────────
      const [backupRows] = await conn.query(
        "SELECT * FROM `target_websites` WHERE `appKey` IS NULL",
      );
      report.backupRowCount = backupRows.length;
      if (report.backupRowCount !== nullCount) {
        logRollback("backup_row_count_mismatch");
        console.error("STOP: backup rows !== null_appkey", {
          backupRowCount: report.backupRowCount,
          nullCount,
        });
        process.exit(2);
      }
      if (report.backupRowCount === 0) {
        logRollback("backup_empty_but_null_count_nonzero");
        console.error("STOP: inconsistent null count vs backup");
        process.exit(2);
      }
      try {
        fs.writeFileSync(BACKUP_PATH, JSON.stringify(backupRows, null, 2), "utf8");
      } catch (e) {
        logRollback("backup_write_failed");
        console.error("STOP: backup write failed", e);
        process.exit(2);
      }
      report.backupPath = BACKUP_PATH;
      console.log("=== STEP 3 — BACKUP OK ===", BACKUP_PATH, "rows=", report.backupRowCount);

      // ── STEP 4 — BACKFILL (transaction) ───────────────────────────────────
      await conn.beginTransaction();
      try {
        const [h1] = await conn.query(`
          UPDATE \`target_websites\`
          SET \`appKey\` = 'telegram'
          WHERE \`appKey\` IS NULL AND \`templateType\` = 'telegram'
        `);
        report.rowsUpdated.telegram = h1.affectedRows ?? 0;

        const [h2] = await conn.query(`
          UPDATE \`target_websites\`
          SET \`appKey\` = 'google-sheets'
          WHERE \`appKey\` IS NULL
            AND \`templateType\` IN ('google-sheets','google_sheets')
        `);
        report.rowsUpdated.googleSheets = h2.affectedRows ?? 0;

        const [h3] = await conn.query(`
          UPDATE \`target_websites\` \`tw\`
          INNER JOIN \`destination_templates\` \`dt\` ON \`dt\`.\`id\` = \`tw\`.\`templateId\`
          SET \`tw\`.\`appKey\` = \`dt\`.\`appKey\`
          WHERE \`tw\`.\`appKey\` IS NULL
            AND \`dt\`.\`appKey\` IS NOT NULL
            AND TRIM(\`dt\`.\`appKey\`) <> ''
        `);
        report.rowsUpdated.fromTemplate = h3.affectedRows ?? 0;

        const [h4] = await conn.query(`
          UPDATE \`target_websites\`
          SET \`appKey\` = 'unknown'
          WHERE \`appKey\` IS NULL
        `);
        report.rowsUpdated.fallbackUnknown = h4.affectedRows ?? 0;

        const [[{ remaining_null }]] = await conn.query(
          "SELECT COUNT(*) AS remaining_null FROM `target_websites` WHERE `appKey` IS NULL",
        );
        report.remainingNullAfterBackfill = Number(remaining_null);

        if (report.remainingNullAfterBackfill > 0) {
          await conn.rollback();
          logRollback("backfill_verify_failed_remaining_null");
          console.error("STOP: remaining_null > 0 after backfill — rolled back DML", report.remainingNullAfterBackfill);
          process.exit(3);
        }
        await conn.commit();
        console.log("=== STEP 4 — BACKFILL COMMITTED ===", report.rowsUpdated);
      } catch (e) {
        await conn.rollback();
        logRollback("backfill_transaction_error");
        console.error("STOP: backfill error — rolled back", e);
        process.exit(3);
      }
    }

    // ── STEP 4.5 / 7 — VERIFY NULLS ─────────────────────────────────────────
    const [[finalNull]] = await conn.query(
      "SELECT COUNT(*) AS remaining_null FROM `target_websites` WHERE `appKey` IS NULL",
    );
    report.remainingNullAfterBackfill = Number(finalNull.remaining_null);
    if (report.remainingNullAfterBackfill > 0) {
      logRollback("pre_ddl_verify_failed");
      console.error("STOP: remaining_null > 0 before DDL", report.remainingNullAfterBackfill);
      process.exit(4);
    }
    console.log("=== STEP 4.5 — remaining_null = 0 ===");

    // ── STEP 5 & 6 — DDL (if still nullable) ────────────────────────────────
    const col = await getColumnNullable(conn);
    if (col?.nullable === "NO" && (col.colDefault == null || col.colDefault === "")) {
      console.log("=== STEP 5/6 SKIP — appKey already NOT NULL without default ===");
    } else {
      try {
        await conn.query(`
          ALTER TABLE \`target_websites\`
          MODIFY COLUMN \`appKey\` VARCHAR(64) NOT NULL DEFAULT 'unknown'
        `);
        console.log("=== STEP 5 — NOT NULL + DEFAULT applied ===");
      } catch (e) {
        logRollback("alter_not_null_default_failed");
        console.error("STOP: ALTER NOT NULL DEFAULT failed", e);
        process.exit(5);
      }
      try {
        await conn.query(`
          ALTER TABLE \`target_websites\`
          MODIFY COLUMN \`appKey\` VARCHAR(64) NOT NULL
        `);
        console.log("=== STEP 6 — DEFAULT removed (strict NOT NULL) ===");
      } catch (e) {
        logRollback("alter_drop_default_failed");
        console.error("CRITICAL: second ALTER failed — column may still have DEFAULT", e);
        process.exit(6);
      }
    }

    const [[verify]] = await conn.query(
      "SELECT COUNT(*) AS remaining_null FROM `target_websites` WHERE `appKey` IS NULL",
    );
    report.columnAfter = await getColumnNullable(conn);
    console.log("=== STEP 7 — FINAL ===");
    console.log(JSON.stringify({ remaining_null: verify.remaining_null, column: report.columnAfter }, null, 2));

    if (Number(verify.remaining_null) !== 0) {
      console.error("UNEXPECTED: remaining_null !== 0");
        process.exit(7);
    }

    console.log("=== MIGRATION STATUS: SUCCESS ===");
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    logRollback("unexpected_top_level");
    console.error("STOP:", e);
    process.exit(99);
  } finally {
    await conn.end();
  }
}

main();

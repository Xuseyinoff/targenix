/**
 * Read-only + optional backup for connection_app_specs removal gate.
 * Usage: railway run node tooling/mysql/audit-connection-app-specs-drop.mjs
 * Env: MYSQL_PUBLIC_URL | MYSQL_URL | DATABASE_URL (mysql://)
 */
import fs from "fs";
import os from "os";
import path from "path";
import mysql from "mysql2/promise";

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

const REQUIRED_APP_KEYS = new Set([
  "alijahon",
  "mgoods",
  "sotuvchi",
  "inbaza",
  "100k",
  "open_affiliate",
  "telegram",
  "google-sheets",
]);

async function main() {
  const url = pickMysqlUrl();
  if (!url) {
    console.error(JSON.stringify({ ok: false, error: "No mysql:// URL in env" }));
    process.exit(2);
  }

  const conn = await mysql.createConnection(url);

  const [specTableRows] = await conn.query(
    "SHOW TABLES LIKE 'connection_app_specs'",
  );
  const tableExists = Array.isArray(specTableRows) && specTableRows.length > 0;

  const [[appsTotalRow]] = await conn.query("SELECT COUNT(*) AS total FROM apps");
  const total = Number(appsTotalRow?.total ?? 0);

  const [keyRows] = await conn.query(
    "SELECT appKey FROM apps WHERE isActive = 1 ORDER BY appKey",
  );
  const appKeys = keyRows.map((r) => r.appKey);
  const keySet = new Set(appKeys);

  const missing = [...REQUIRED_APP_KEYS].filter((k) => !keySet.has(k));

  let specRows = [];
  if (tableExists) {
    const [rows] = await conn.query("SELECT * FROM connection_app_specs ORDER BY id");
    specRows = rows;
  }

  await conn.end();

  const backupPath = path.join(os.tmpdir(), "backup_connection_app_specs.json");
  let backupOk = !tableExists;
  if (tableExists) {
    try {
      fs.writeFileSync(
        backupPath,
        JSON.stringify({ exportedAt: new Date().toISOString(), rows: specRows }, null, 2),
        "utf8",
      );
      backupOk = true;
    } catch (e) {
      console.error("Backup write failed:", e);
      backupOk = false;
    }
  }

  const coverageOk = missing.length === 0 && total > 0;
  const readyToDrop = tableExists && coverageOk && backupOk;
  const alreadyGone = !tableExists && coverageOk;

  const gate = {
    coverageOk,
    readyToDrop,
    alreadyGone,
    tableExists,
    appsTotal: total,
    appKeys,
    requiredMissing: missing,
    backupPath,
    backupOk,
    connectionAppSpecsRowCount: specRows.length,
  };

  console.log(JSON.stringify(gate, null, 2));
  process.exit(readyToDrop || alreadyGone ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

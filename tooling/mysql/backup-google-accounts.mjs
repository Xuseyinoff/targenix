/**
 * Railway-safe backup of legacy google_accounts table (before DROP).
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/mysql/backup-google-accounts.mjs
 *
 * Output:
 *   tooling/mysql/backups/google_accounts-backup-<timestamp>.sql
 *   tooling/mysql/backups/google_accounts-backup-<timestamp>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mysql from "mysql2/promise";

function pickMysqlUrl() {
  for (const raw of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

function sqlEscapeString(v) {
  // minimal, safe for mysqldump-like output
  return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function sqlValue(v) {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) return sqlEscapeString(v.toISOString().slice(0, 19).replace("T", " "));
  return sqlEscapeString(v);
}

const url = pickMysqlUrl();
if (!url) {
  console.error("No mysql:// URL found in env");
  process.exit(2);
}

const conn = await mysql.createConnection(url);
try {
  const [rows] = await conn.query("SELECT * FROM google_accounts ORDER BY id ASC");
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const outDir = join(process.cwd(), "tooling", "mysql", "backups");
  await mkdir(outDir, { recursive: true });

  const jsonPath = join(outDir, `google_accounts-backup-${stamp}.json`);
  const sqlPath = join(outDir, `google_accounts-backup-${stamp}.sql`);

  await writeFile(jsonPath, JSON.stringify(rows, null, 2), "utf8");

  const columns = rows.length ? Object.keys(rows[0]) : [];
  const header = [
    "-- Backup of google_accounts",
    `-- created_at: ${now.toISOString()}`,
    `-- rows: ${rows.length}`,
    "",
    "SET FOREIGN_KEY_CHECKS=0;",
    "",
    "-- Recreate table structure (best-effort from current DB)",
  ].join("\n");

  const [ddlRows] = await conn.query("SHOW CREATE TABLE google_accounts");
  const ddl = ddlRows?.[0]?.["Create Table"];
  const createStmt = ddl ? `${ddl};` : "-- SHOW CREATE TABLE failed; restore manually.";

  const inserts = rows.map((r) => {
    const cols = columns.map((c) => `\`${c}\``).join(", ");
    const vals = columns.map((c) => sqlValue(r[c])).join(", ");
    return `INSERT INTO \`google_accounts\` (${cols}) VALUES (${vals});`;
  });

  const sql = [header, createStmt, "", ...inserts, "", "SET FOREIGN_KEY_CHECKS=1;", ""].join("\n");
  await writeFile(sqlPath, sql, "utf8");

  console.log(JSON.stringify({ ok: true, rows: rows.length, sqlPath, jsonPath }, null, 2));
} finally {
  await conn.end();
}


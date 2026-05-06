/**
 * Batch: remove legacy `templateConfig.secrets` from `target_websites` ONLY when
 * it is safe — row has `connectionId` and prod has flipped the global
 * connection-secrets-only switch (same semantics as server/services/featureFlags.ts).
 *
 * Prerequisite (apply / backup-for-apply): global flag ON:
 *   USE_CONNECTION_SECRETS_ONLY_ALL=true  OR  USE_CONNECTION_SECRETS_ONLY=true
 * (Per-user allowlist alone is NOT enough for a fleet-wide strip — users off the
 * list could still rely on templateConfig.secrets if their connection were empty.)
 *
 * Usage:
 *   railway run --service <svc> node tooling/mysql/strip-templateconfig-secrets-batch.mjs audit
 *   railway run --service <svc> node tooling/mysql/strip-templateconfig-secrets-batch.mjs backup [--out=backup_template_secrets.json]
 *   railway run --service <svc> node tooling/mysql/strip-templateconfig-secrets-batch.mjs dry-run
 *   railway run --service <svc> node tooling/mysql/strip-templateconfig-secrets-batch.mjs apply --backup=backup_template_secrets.json
 *   railway run --service <svc> node tooling/mysql/strip-templateconfig-secrets-batch.mjs verify
 *   railway run --service <svc> node tooling/mysql/strip-templateconfig-secrets-batch.mjs rollback --backup=backup_template_secrets.json
 *
 * Env (same priority as tw-strip-secrets-temp.mjs):
 *   MYSQL_PUBLIC_URL | MYSQL_URL | DATABASE_URL
 *
 * Also load .env when present (dotenv).
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

function parseBool(raw) {
  if (raw == null || String(raw).trim() === "") return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Mirrors FLAG_CONNECTION_SECRETS_ONLY global branch (featureFlags.ts). */
function isGlobalConnectionSecretsOnlyOn() {
  return (
    parseBool(process.env.USE_CONNECTION_SECRETS_ONLY_ALL) ||
    parseBool(process.env.USE_CONNECTION_SECRETS_ONLY)
  );
}

function parseArgs(argv) {
  const cmd = argv[0] ?? "help";
  const out = { cmd, outFile: "backup_template_secrets.json", backupFile: null };
  for (const a of argv.slice(1)) {
    if (a.startsWith("--out=")) out.outFile = a.slice("--out=".length);
    if (a.startsWith("--backup=")) out.backupFile = a.slice("--backup=".length);
  }
  return out;
}

const CANDIDATE_SQL = `
SELECT id, userId, connectionId, templateId, templateConfig
FROM target_websites
WHERE connectionId IS NOT NULL
  AND templateConfig IS NOT NULL
  AND JSON_VALID(templateConfig)
  AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')
`;

/** Rows that would lose secrets in template JSON (same WHERE as apply). */
async function loadCandidates(conn) {
  const [rows] = await conn.query(CANDIDATE_SQL);
  return rows;
}

async function audit(conn) {
  const [t] = await conn.query(`SELECT COUNT(*) AS total FROM target_websites`);
  const total = Number(t[0]?.total ?? 0);

  const [a] = await conn.query(
    `SELECT COUNT(*) AS withSecretsPath
     FROM target_websites
     WHERE templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );
  const withSecretsPath = Number(a[0]?.withSecretsPath ?? 0);

  const [b] = await conn.query(
    `SELECT COUNT(*) AS withSecretsAndConn
     FROM target_websites
     WHERE connectionId IS NOT NULL
       AND templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );
  const withSecretsAndConn = Number(b[0]?.withSecretsAndConn ?? 0);

  const [c] = await conn.query(
    `SELECT COUNT(*) AS withSecretsNoConn
     FROM target_websites
     WHERE connectionId IS NULL
       AND templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );
  const withSecretsNoConn = Number(c[0]?.withSecretsNoConn ?? 0);

  const globalOn = isGlobalConnectionSecretsOnlyOn();

  console.log(JSON.stringify({
    step: "audit",
    useConnectionSecretsOnlyGlobal: globalOn,
    env: {
      USE_CONNECTION_SECRETS_ONLY_ALL: process.env.USE_CONNECTION_SECRETS_ONLY_ALL ?? null,
      USE_CONNECTION_SECRETS_ONLY: process.env.USE_CONNECTION_SECRETS_ONLY ?? null,
      USE_CONNECTION_SECRETS_ONLY_USER_IDS: process.env.USE_CONNECTION_SECRETS_ONLY_USER_IDS ?? null,
    },
    target_websites: {
      totalRows: total,
      rowsWithTemplateConfigSecretsPath: withSecretsPath,
      safeToStrip_connectionIdNotNull: withSecretsAndConn,
      unsafeSkip_connectionIdNull: withSecretsNoConn,
    },
    note: globalOn
      ? "Global flag ON — fleet relies on connections; stripping templateConfig.secrets for linked rows is aligned with resolveSecretsForDelivery."
      : "WARNING: global flag OFF — do NOT apply batch strip; tenants may still use templateConfig.secrets fallback.",
  }, null, 2));
}

async function dryRun(conn) {
  const rows = await loadCandidates(conn);
  console.log(JSON.stringify({
    step: "dry-run",
    useConnectionSecretsOnlyGlobal: isGlobalConnectionSecretsOnlyOn(),
    wouldUpdateCount: rows.length,
    ids: rows.map((r) => r.id),
    sample: rows.slice(0, 20).map((r) => ({
      id: r.id,
      userId: r.userId,
      connectionId: r.connectionId,
      templateId: r.templateId,
      hasSecretsKey: true,
    })),
  }, null, 2));
}

async function backup(conn, outFile) {
  if (!isGlobalConnectionSecretsOnlyOn()) {
    console.error(
      "Refuse backup for apply set: global USE_CONNECTION_SECRETS_ONLY is not ON. Fix env first.",
    );
    process.exit(1);
  }
  const rows = await loadCandidates(conn);
  const abs = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
  const payload = {
    meta: {
      purpose: "strip-templateconfig-secrets-batch",
      createdAt: new Date().toISOString(),
      host: os.hostname(),
      globalConnectionSecretsOnly: true,
      rowCount: rows.length,
    },
    rows: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      connectionId: r.connectionId,
      templateId: r.templateId,
      templateConfig: r.templateConfig,
    })),
  };
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({ step: "backup", path: abs, rows: rows.length }, null, 2));
}

async function apply(conn, backupFile) {
  if (!isGlobalConnectionSecretsOnlyOn()) {
    console.error("Refuse apply: global USE_CONNECTION_SECRETS_ONLY is not ON.");
    process.exit(1);
  }
  const abs = path.isAbsolute(backupFile)
    ? backupFile
    : path.join(process.cwd(), backupFile);
  if (!fs.existsSync(abs)) {
    console.error("Backup file not found:", abs);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));
  const idsFromBackup = new Set(data.rows.map((r) => r.id));

  const [res] = await conn.query(
    `UPDATE target_websites
     SET templateConfig = JSON_REMOVE(templateConfig, '$.secrets')
     WHERE connectionId IS NOT NULL
       AND templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );

  const affected = res.affectedRows ?? 0;
  const [v] = await conn.query(
    `SELECT COUNT(*) AS n
     FROM target_websites
     WHERE connectionId IS NOT NULL
       AND templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );
  const stillWithPath = Number(v[0]?.n ?? 0);

  console.log(JSON.stringify({
    step: "apply",
    backupUsed: abs,
    backupRowCount: data.rows?.length ?? 0,
    mysqlAffectedRows: affected,
    linkedRowsStillHavingSecretsPath: stillWithPath,
    warning:
      affected !== idsFromBackup.size
        ? "affectedRows differs from backup row count — re-run audit; backup may be stale."
        : undefined,
  }, null, 2));
}

async function verify(conn) {
  const [t] = await conn.query(`SELECT COUNT(*) AS total FROM target_websites`);
  const [a] = await conn.query(
    `SELECT COUNT(*) AS n
     FROM target_websites
     WHERE templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );
  const [b] = await conn.query(
    `SELECT COUNT(*) AS n
     FROM target_websites
     WHERE connectionId IS NOT NULL
       AND templateConfig IS NOT NULL
       AND JSON_VALID(templateConfig)
       AND JSON_CONTAINS_PATH(templateConfig, 'one', '$.secrets')`,
  );
  console.log(JSON.stringify({
    step: "verify",
    totalRows: Number(t[0]?.total ?? 0),
    rowsWithSecretsPathRemaining: Number(a[0]?.n ?? 0),
    linkedRowsWithSecretsPathRemaining: Number(b[0]?.n ?? 0),
  }, null, 2));
}

async function rollback(conn, backupFile) {
  const abs = path.isAbsolute(backupFile)
    ? backupFile
    : path.join(process.cwd(), backupFile);
  if (!fs.existsSync(abs)) {
    console.error("Backup file not found:", abs);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));
  let ok = 0;
  for (const row of data.rows) {
    await conn.query(`UPDATE target_websites SET templateConfig = ? WHERE id = ?`, [
      JSON.stringify(row.templateConfig),
      row.id,
    ]);
    ok += 1;
  }
  console.log(JSON.stringify({ step: "rollback", restored: ok, backup: abs }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const { cmd, outFile, backupFile } = parseArgs(argv);

  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL");
    process.exit(1);
  }

  const conn = await mysql.createConnection({ uri: url });
  try {
    if (cmd === "audit" || cmd === "dry-run") {
      if (cmd === "audit") await audit(conn);
      else await dryRun(conn);
      return;
    }

    if (cmd === "backup") {
      await backup(conn, outFile);
      return;
    }

    if (cmd === "apply") {
      if (!backupFile) {
        console.error("apply requires --backup=backup_template_secrets.json");
        process.exit(1);
      }
      await apply(conn, backupFile);
      return;
    }

    if (cmd === "verify") {
      await verify(conn);
      return;
    }

    if (cmd === "rollback") {
      if (!backupFile) {
        console.error("rollback requires --backup=...");
        process.exit(1);
      }
      await rollback(conn, backupFile);
      return;
    }

    console.log(`Commands:
  audit       — counts (total / secrets path / safe vs unsafe by connectionId)
  dry-run     — list candidate ids for strip (no DB write)
  backup      — write JSON backup of rows that apply would touch (requires global flag ON)
  apply       — JSON_REMOVE $.secrets for candidates (requires global flag ON + backup file)
  verify      — post-migration counts
  rollback    — restore templateConfig from backup (does not touch connections)

Global flag (must be true for backup/apply):
  USE_CONNECTION_SECRETS_ONLY_ALL=true  OR  USE_CONNECTION_SECRETS_ONLY=true
`);
    process.exit(cmd === "help" ? 0 : 1);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e?.code ?? e?.name, e?.message ?? String(e));
  process.exit(1);
});

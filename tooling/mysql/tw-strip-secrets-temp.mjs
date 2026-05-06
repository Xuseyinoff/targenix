/**
 * Temporarily remove templateConfig.secrets for a target_websites row
 * while keeping a copy inside templateConfig as secrets__tmp_stripped_backup.
 *
 *   railway run --service targenix.uz node tooling/mysql/tw-strip-secrets-temp.mjs --strip --tw=60002
 *   railway run --service targenix.uz node tooling/mysql/tw-strip-secrets-temp.mjs --restore --tw=60002
 */

import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

function parseArgs(argv) {
  const o = { strip: false, restore: false, tw: null };
  for (const a of argv) {
    if (a === "--strip") o.strip = true;
    if (a === "--restore") o.restore = true;
    if (a.startsWith("--tw=")) o.tw = parseInt(a.slice("--tw=".length), 10);
  }
  return o;
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return { ...v };
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

const BACKUP_KEY = "secrets__tmp_stripped_backup";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.strip === args.restore || !args.tw) {
    console.error("Usage: --strip --tw=ID  |  --restore --tw=ID");
    process.exit(1);
  }
  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL url");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [[row]] = await conn.query(
      `SELECT id, userId, templateId, connectionId, templateConfig FROM target_websites WHERE id = ? LIMIT 1`,
      [args.tw],
    );
    if (!row) {
      console.error("Row not found");
      process.exit(1);
    }

    const cfg = safeJson(row.templateConfig);
    if (!cfg || typeof cfg !== "object") {
      console.error("Invalid templateConfig");
      process.exit(1);
    }

    if (args.strip) {
      if (cfg[BACKUP_KEY] != null) {
        console.error("Refuse: backup key already present — run --restore first or fix manually.");
        process.exit(1);
      }
      if (!cfg.secrets || typeof cfg.secrets !== "object") {
        console.error("No secrets to strip");
        process.exit(1);
      }
      cfg[BACKUP_KEY] = cfg.secrets;
      delete cfg.secrets;
      await conn.query(`UPDATE target_websites SET templateConfig = ? WHERE id = ?`, [
        JSON.stringify(cfg),
        args.tw,
      ]);
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: "strip",
            twId: args.tw,
            hadConnectionId: row.connectionId,
            hadTemplateId: row.templateId,
            note: `secrets removed; copy under key "${BACKUP_KEY}" until --restore`,
          },
          null,
          2,
        ),
      );
    } else {
      if (cfg[BACKUP_KEY] == null) {
        console.error("No backup key present — nothing to restore.");
        process.exit(1);
      }
      cfg.secrets = cfg[BACKUP_KEY];
      delete cfg[BACKUP_KEY];
      await conn.query(`UPDATE target_websites SET templateConfig = ? WHERE id = ?`, [
        JSON.stringify(cfg),
        args.tw,
      ]);
      console.log(
        JSON.stringify(
          { ok: true, action: "restore", twId: args.tw },
          null,
          2,
        ),
      );
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

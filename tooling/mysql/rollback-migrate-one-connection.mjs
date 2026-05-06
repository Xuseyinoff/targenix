/**
 * `migrate-one-target-to-template-connection.mjs` o'rnatgan bog'lanishni
 * bekor: target `templateId` / `connectionId` null qilinadi, `connections`
 * qator o'chiriladi. `templateConfig` o'zgartirilmaydi — `secrets` saqlanib
 * qolsa, legacy yo'l qayta ishga tushadi.
 *
 *   --tw=30003
 *   --connection=22  (ixtiyoriy: tw dan o'qib tekshiradi)
 *   --dry-run | --apply --confirm=ROLLBACK_ONE
 *
 * Railway:
 *   railway run --service targenix.uz node tooling/mysql/rollback-migrate-one-connection.mjs --dry-run --tw=30003
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
  const o = { dryRun: false, apply: false, tw: null, connection: null, confirm: null };
  for (const a of argv) {
    if (a === "--dry-run") o.dryRun = true;
    if (a === "--apply") o.apply = true;
    if (a.startsWith("--tw=")) o.tw = parseInt(a.slice("--tw=".length), 10);
    if (a.startsWith("--connection="))
      o.connection = parseInt(a.slice("--connection=".length), 10);
    if (a.startsWith("--confirm=")) o.confirm = a.slice(10);
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args.dryRun && !args.apply) || (args.dryRun && args.apply)) {
    console.error("Bittasini: --dry-run yoki --apply");
    process.exit(1);
  }
  if (!args.tw) {
    console.error("Kerak: --tw=<target_websites.id>");
    process.exit(1);
  }
  if (args.apply && args.confirm !== "ROLLBACK_ONE") {
    console.error("Apply: --confirm=ROLLBACK_ONE");
    process.exit(1);
  }

  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [[tw]] = await conn.query(
      `SELECT id, userId, name, templateId, connectionId
         FROM target_websites WHERE id = ? LIMIT 1`,
      [args.tw],
    );
    if (!tw) {
      console.error("target topilmadi");
      process.exit(1);
    }
    if (tw.templateId == null && tw.connectionId == null) {
      console.log(
        JSON.stringify(
          { note: "allaqachon legacy holat: templateId va connectionId NULL" },
          null,
          2,
        ),
      );
      process.exit(0);
    }

    const expectedConn = args.connection ?? tw.connectionId;
    if (args.connection && tw.connectionId && tw.connectionId !== args.connection) {
      console.error(
        `target.connectionId=${tw.connectionId} siz bergan --connection=${args.connection} emas; xavf — to'xtatildi`,
      );
      process.exit(1);
    }
    if (!expectedConn) {
      console.error("target.connectionId NULL, lekin templateId to'ldirilgan? tekshiring");
      process.exit(1);
    }

    const [[c]] = await conn.query(
      `SELECT id, userId, displayName, appKey FROM connections WHERE id = ? LIMIT 1`,
      [expectedConn],
    );
    if (!c) {
      console.error(`connections id=${expectedConn} topilmadi`);
      process.exit(1);
    }
    if (c.userId !== tw.userId) {
      console.error("connection userId target bilan mos emas");
      process.exit(1);
    }

    const plan = {
      targetWebsite: { id: tw.id, name: tw.name, userId: tw.userId },
      clear: { templateId: tw.templateId, connectionId: tw.connectionId },
      deleteConnection: { id: c.id, displayName: c.displayName, appKey: c.appKey },
    };

    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            mode: "DRY-RUN",
            plan,
            sql: [
              `UPDATE target_websites SET templateId = NULL, connectionId = NULL WHERE id = ${tw.id} AND userId = ${tw.userId};`,
              `DELETE FROM connections WHERE id = ${c.id} AND userId = ${tw.userId};`,
            ],
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }

    await conn.beginTransaction();
    try {
      const [u1] = await conn.query(
        `UPDATE target_websites
            SET templateId = NULL, connectionId = NULL, templateType = 'custom'
          WHERE id = ? AND userId = ?`,
        [tw.id, tw.userId],
      );
      if (u1.affectedRows !== 1) {
        throw new Error("target UPDATE affected 0");
      }
      const [d1] = await conn.query(
        `DELETE FROM connections WHERE id = ? AND userId = ?`,
        [c.id, tw.userId],
      );
      if (d1.affectedRows !== 1) {
        throw new Error("DELETE connection affected 0");
      }
      await conn.commit();
      console.log(
        JSON.stringify(
          {
            ok: true,
            reMigrateHint: `Qayta migrate: migrate-one ... --tw=${tw.id} --template=<tpl>`,
            plan,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

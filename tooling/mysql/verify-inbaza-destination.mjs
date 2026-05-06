/**
 * Bitta affiliate `target_websites` + `connections` + integratsiyalar
 * o'qitish-rejimidagi tekshiruv (migratsiyadan keyin "hammasi joyidami").
 * Default: Inbaza. Alijahon uchun: --app-key=alijahon --tw=30003 --connection=... --expected-template=5
 *
 *   node tooling/mysql/verify-inbaza-destination.mjs
 *   node tooling/mysql/verify-inbaza-destination.mjs --user-id=1 --tw=30003 --connection=22 --app-key=alijahon --expected-template=5
 *
 * Railway:
 *   railway run --service targenix.uz node tooling/mysql/verify-inbaza-destination.mjs
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
  const o = {
    userId: 1,
    tw: 60002,
    connection: 21,
    expectedTemplate: 4,
    appKey: "inbaza",
  };
  for (const a of argv) {
    if (a.startsWith("--user-id="))
      o.userId = parseInt(a.slice("--user-id=".length), 10);
    if (a.startsWith("--tw=")) o.tw = parseInt(a.slice("--tw=".length), 10);
    if (a.startsWith("--connection="))
      o.connection = parseInt(a.slice("--connection=".length), 10);
    if (a.startsWith("--expected-template="))
      o.expectedTemplate = parseInt(a.slice("--expected-template=".length), 10);
    if (a.startsWith("--app-key=")) o.appKey = a.slice("--app-key=".length) || "inbaza";
  }
  return o;
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL url");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  const issues = [];
  const notes = [];
  const ok = [];

  try {
    const [[tw]] = await conn.query(
      `SELECT id, userId, name, url, templateId, connectionId, isActive, templateConfig
         FROM target_websites
        WHERE id = ? LIMIT 1`,
      [args.tw],
    );
    if (!tw) {
      issues.push(`target_websites id=${args.tw} topilmadi`);
    } else {
      if (tw.userId !== args.userId) {
        issues.push(
          `target userId=${tw.userId} kutilgan --user-id=${args.userId} emas`,
        );
      } else ok.push("target_websites.userId");

      if (!tw.isActive) issues.push("target isActive=0");
      else ok.push("target isActive");

      if (tw.connectionId == null) {
        issues.push("target connectionId NULL — migratsiya to'liq emas");
      } else if (tw.connectionId !== args.connection) {
        issues.push(
          `target connectionId=${tw.connectionId} (kutilgan ${args.connection})`,
        );
      } else ok.push("target.connectionId");

      if (tw.templateId == null) {
        issues.push("target templateId NULL");
      } else if (tw.templateId !== args.expectedTemplate) {
        issues.push(
          `target templateId=${tw.templateId} (kutilgan ${args.expectedTemplate} — o'zgarsa ham ishlashi mumkin)`,
        );
      } else ok.push("target.templateId (kutilgan " + args.expectedTemplate + ")");

      const cfg = safeJson(tw.templateConfig) ?? {};
      const hasLegacySecrets =
        cfg.secrets &&
        typeof cfg.secrets === "object" &&
        !Array.isArray(cfg.secrets) &&
        Object.keys(cfg.secrets).length > 0;
      const hasBackup = !!cfg.secrets__tmp_stripped_backup;
      if (hasBackup && !hasLegacySecrets) {
        ok.push(
          "templateConfig: asosiy `secrets` yo'q, `secrets__tmp_stripped_backup` bor — keyin tozalab qo'ying (active connection sirmalari yetarli)",
        );
      }
      if (hasLegacySecrets && tw.connectionId) {
        notes.push(
          "templateConfig.secrets hali bor — runtime connection ustun; keyinroq faqat connection qolsin (ixtiyoriy tozalash)",
        );
      }
    }

    const [[c]] = await conn.query(
      `SELECT id, userId, type, appKey, displayName, status, credentialsJson
         FROM connections
        WHERE id = ? LIMIT 1`,
      [args.connection],
    );
    if (!c) {
      issues.push(`connections id=${args.connection} topilmadi`);
    } else {
      if (c.userId !== args.userId) {
        issues.push(
          `connection userId=${c.userId} (target user bilan mos emas)`,
        );
      } else ok.push("connections.userId");
      if (c.status !== "active") {
        issues.push(`connection status=${c.status} (active emas)`);
      } else ok.push("connection.status=active");
      if (c.appKey && c.appKey !== args.appKey) {
        issues.push(
          `connection appKey='${c.appKey}' (kutilgan '${args.appKey}')`,
        );
      } else if (c.appKey === args.appKey) {
        ok.push(`connection.appKey=${args.appKey}`);
      } else
        issues.push(
          `connection appKey null — 0046+ migratsiyadan keyin ${args.appKey} bo'lishi tavsiya`,
        );

      const creds = safeJson(c.credentialsJson) ?? {};
      const se = creds.secretsEncrypted;
      const hasEnc =
        se &&
        typeof se === "object" &&
        !Array.isArray(se) &&
        Object.keys(se).length > 0;
      if (!hasEnc) {
        issues.push("connections.credentialsJson.secretsEncrypted bo'sh yoki yo'q");
      } else {
        ok.push("connections.secretsEncrypted (api_key va h.k.)");
      }
    }

    if (tw && c && tw.connectionId && tw.connectionId !== c.id) {
      issues.push("target.connectionId va --connection bitta qator emas (yuqoridagi xato bilan birga)");
    }

    const [integs] = await conn.query(
      `SELECT i.id, i.name, i.isActive, i.targetWebsiteId
         FROM integrations i
        WHERE i.type = 'LEAD_ROUTING' AND i.userId = ? AND i.targetWebsiteId = ?`,
      [args.userId, args.tw],
    );
    const [idests] = await conn.query(
      `SELECT idj.integrationId, i.name
         FROM integration_destinations idj
         JOIN integrations i ON i.id = idj.integrationId
        WHERE i.userId = ? AND idj.targetWebsiteId = ? AND idj.enabled = 1`,
      [args.userId, args.tw],
    );
    const fromJoin = new Set(idests.map((r) => r.integrationId));
    for (const row of integs) {
      if (!fromJoin.has(row.id)) {
        issues.push(
          `integration id=${row.id} ustunda target=${args.tw}, lekin integration_destinations da yo'q (MULTI_DEST yoq muhitda ham ishlaydi, lekin dual-write siliq emas)`,
        );
      }
    }
    ok.push(
      `LEAD_ROUTING (ustun=tw) ${args.tw}: ${integs.length} ta, join: ${idests.length} ta`,
    );

    const report = {
      checked: {
        userId: args.userId,
        targetWebsiteId: args.tw,
        connectionId: args.connection,
        expectedTemplateId: args.expectedTemplate,
        appKey: args.appKey,
      },
      ok,
      notes,
      issues,
      integrations: integs,
    };
    console.log(JSON.stringify(report, null, 2));
    if (issues.length) {
      process.exit(2);
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

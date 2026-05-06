/**
 * Read-only: bitta user uchun Inbaza ga bog‘langan LEAD_ROUTING integratsiyalari
 * (target_websites: url yoki name da "inbaza" bo‘lgan manzillar).
 * Xavfsiz repoint yoki auditdan oldin qaysi `integration.id` tegish ekanini ko‘rish.
 *
 *   node tooling/mysql/list-user-inbaza-integrations.mjs
 *   node tooling/mysql/list-user-inbaza-integrations.mjs --user-id=1
 *
 * Railway:
 *   railway run --service targenix.uz node tooling/mysql/list-user-inbaza-integrations.mjs --user-id=1
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

function parseUserId(argv) {
  const a = argv.find((x) => x.startsWith("--user-id="));
  if (!a) return 1;
  const n = Number(a.slice("--user-id=".length));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractTwIdFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const raw = cfg.targetWebsiteId;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
}

function isInbazaTw(tw) {
  const u = (tw?.url ?? "").toLowerCase();
  const n = (tw?.name ?? "").toLowerCase();
  return u.includes("inbaza") || n.includes("inbaza");
}

async function main() {
  const userId = parseUserId(process.argv.slice(2));
  if (userId == null) {
    console.error("Invalid --user-id (must be a positive number).");
    process.exit(1);
  }
  const url = getMysqlUrl();
  if (!url) {
    console.error("No DB URL. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [inbazaTargets] = await conn.query(
      `SELECT id, name, url, templateId, connectionId
         FROM target_websites
        WHERE userId = ?`,
      [userId],
    );
    const inbaza = inbazaTargets.filter(isInbazaTw);
    const inbazaIdSet = new Set(inbaza.map((r) => r.id));

    console.log(
      `userId=${userId}  |  Inbaza shartiga mos target_websites: ${inbaza.length} ta\n`,
    );
    for (const t of inbaza) {
      console.log(
        `  tw=${t.id}  name=${JSON.stringify(t.name)}  url=${t.url}  templateId=${t.templateId}  connectionId=${t.connectionId}`,
      );
    }
    if (inbaza.length === 0) {
      console.log(
        "\n(Hech qanday inbaza destination topilmadi — url/name da \"inbaza\" bo‘lishi kerak.)",
      );
    }
    console.log("");

    const [integrations] = await conn.query(
      `SELECT id, userId, type, name, isActive, targetWebsiteId, pageId, formId, config
         FROM integrations
        WHERE userId = ? AND type = 'LEAD_ROUTING'`,
      [userId],
    );

    const intIds = integrations.map((r) => r.id);
    const byInt = new Map();
    if (intIds.length) {
      const ph = intIds.map(() => "?").join(",");
      const [allDest] = await conn.query(
        `SELECT integrationId, targetWebsiteId, position, enabled
           FROM integration_destinations
          WHERE integrationId IN (${ph})`,
        intIds,
      );
      for (const d of allDest) {
        if (!byInt.has(d.integrationId)) byInt.set(d.integrationId, []);
        byInt.get(d.integrationId).push(d);
      }
    }

    const hits = [];
    for (const row of integrations) {
      let cfg;
      try {
        cfg =
          typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      } catch {
        cfg = null;
      }
      const twFromCfg = extractTwIdFromConfig(cfg);
      const twIds = new Set();
      if (row.targetWebsiteId) twIds.add(row.targetWebsiteId);
      if (twFromCfg) twIds.add(twFromCfg);
      for (const d of byInt.get(row.id) ?? [])
        twIds.add(d.targetWebsiteId);

      const inbazaRefs = [...twIds].filter((id) => inbazaIdSet.has(id));
      if (inbazaRefs.length > 0) {
        hits.push({
          id: row.id,
          name: row.name,
          isActive: row.isActive,
          pageId: row.pageId,
          formId: row.formId,
          inbazaTargetIds: inbazaRefs,
          allTwIds: [...twIds].sort((a, b) => a - b),
        });
      }
    }

    console.log(
      `Inbaza manziliga yuboradigan (yoki join orqali bog‘langan) integratsiyalar: ${hits.length} ta\n`,
    );
    for (const h of hits) {
      console.log(
        `  int=${h.id}  active=${h.isActive}  inbaza_tw=[${h.inbazaTargetIds.join(", ")}]  barcha_tw=[${h.allTwIds.join(", ")}]  name=${JSON.stringify(h.name)}`,
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

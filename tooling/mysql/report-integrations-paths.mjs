/**
 * Read-only: integrations → destination path (connection vs legacy secrets),
 * counts by user, orders last 24h per integration.
 *
 *   railway run --service targenix.uz node tooling/mysql/report-integrations-paths.mjs
 *   SUMMARY_ONLY=1 railway run ...   (faqat summary + integratsiyalar ro‘yxatisiz)
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

function twPathLabel(tw) {
  const hasConn = tw.connectionId != null;
  const cfg = safeJson(tw.templateConfig) ?? {};
  const sec = cfg.secrets;
  const hasTplSecrets =
    sec &&
    typeof sec === "object" &&
    !Array.isArray(sec) &&
    Object.keys(sec).length > 0;
  if (hasConn) {
    if (tw.templateId != null) return "connection+dynamic_tpl";
    return "connection+legacy_tpl";
  }
  if (hasTplSecrets) return "faqat_templateConfig_secrets";
  if (tw.templateId != null) return "templateId_bez_connection";
  return "sir_yoqligi_aniq_emas";
}

async function main() {
  const summaryOnly = process.env.SUMMARY_ONLY === "1" || process.env.SUMMARY_ONLY === "true";
  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL url");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [[{ total }]] = await conn.query(
      `SELECT COUNT(*) AS total FROM integrations`,
    );

    const [byUser] = await conn.query(
      `
      SELECT userId, COUNT(*) AS n
        FROM integrations
       GROUP BY userId
       ORDER BY n DESC
       LIMIT 25
      `,
    );

    const [[top1]] = await conn.query(
      `
      SELECT userId, COUNT(*) AS n
        FROM integrations
       GROUP BY userId
       ORDER BY n DESC
       LIMIT 1
      `,
    );

    const [orders1d] = await conn.query(
      `
      SELECT integrationId, COUNT(*) AS orders_24h
        FROM orders
       WHERE createdAt >= (UTC_TIMESTAMP() - INTERVAL 1 DAY)
       GROUP BY integrationId
      `,
    );
    const ordersMap = new Map(
      orders1d.map((r) => [r.integrationId, Number(r.orders_24h)]),
    );

    const [destRows] = await conn.query(
      `
      SELECT integrationId, targetWebsiteId
        FROM integration_destinations
       WHERE enabled = 1
      `,
    );
    const multiMap = new Map();
    for (const r of destRows) {
      if (!multiMap.has(r.integrationId)) multiMap.set(r.integrationId, []);
      multiMap.get(r.integrationId).push(r.targetWebsiteId);
    }

    const [integrations] = await conn.query(
      `
      SELECT id, userId, type, name, isActive, targetWebsiteId, pageId, formId
        FROM integrations
       ORDER BY userId ASC, id ASC
      `,
    );

    const allTwIds = new Set();
    for (const i of integrations) {
      if (i.targetWebsiteId) allTwIds.add(i.targetWebsiteId);
      for (const tid of multiMap.get(i.id) ?? []) allTwIds.add(tid);
    }
    const twList = [...allTwIds];
    const twById = new Map();
    if (twList.length) {
      const chunk = 500;
      for (let o = 0; o < twList.length; o += chunk) {
        const slice = twList.slice(o, o + chunk);
        const ph = slice.map(() => "?").join(",");
        const [rows] = await conn.query(
          `SELECT id, templateId, connectionId, templateConfig FROM target_websites WHERE id IN (${ph})`,
          slice,
        );
        for (const r of rows) twById.set(r.id, r);
      }
    }

    let hammasi_connection = 0;
    let aralash = 0;
    let faqat_legacy = 0;
    let boshqa = 0;
    let integ_with_order_1d = 0;

    const perIntegration = [];

    for (const i of integrations) {
      const twIds = new Set();
      if (i.targetWebsiteId) twIds.add(i.targetWebsiteId);
      for (const x of multiMap.get(i.id) ?? []) twIds.add(x);

      const labels = [];
      for (const tid of twIds) {
        const tw = twById.get(tid);
        if (!tw) {
          labels.push(`tw${tid}:yoq`);
          continue;
        }
        labels.push(`tw${tid}:${twPathLabel(tw)}`);
      }

      let bucket = "boshqa";
      if (twIds.size === 0) {
        bucket = i.type === "AFFILIATE" ? "affiliate_plain" : "manzil_yoq";
        boshqa += 1;
      } else {
        const twRows = [...twIds].map((id) => twById.get(id)).filter(Boolean);
        const allConn = twRows.length && twRows.every((t) => t.connectionId != null);
        const anyConn = twRows.some((t) => t.connectionId != null);
        const anyLegacy = twRows.some((t) => {
          const cfg = safeJson(t.templateConfig) ?? {};
          const s = cfg.secrets;
          return (
            s &&
            typeof s === "object" &&
            !Array.isArray(s) &&
            Object.keys(s).length > 0 &&
            t.connectionId == null
          );
        });
        if (allConn) {
          bucket = "hammasi_connection";
          hammasi_connection += 1;
        } else if (anyConn && anyLegacy) {
          bucket = "aralash";
          aralash += 1;
        } else if (anyLegacy && !anyConn) {
          bucket = "faqat_legacy";
          faqat_legacy += 1;
        } else {
          bucket = "boshqa";
          boshqa += 1;
        }
      }

      const o1 = ordersMap.get(i.id) ?? 0;
      if (o1 > 0) integ_with_order_1d += 1;

      perIntegration.push({
        id: i.id,
        userId: i.userId,
        type: i.type,
        name: i.name,
        isActive: i.isActive,
        pageId: i.pageId,
        formId: i.formId,
        bucket,
        destinationTwIds: [...twIds].sort((a, b) => a - b),
        twPathDetail: labels,
        ordersLast24h: o1,
      });
    }

    const [[orders1dTotal]] = await conn.query(
      `
      SELECT COUNT(*) AS n
        FROM orders
       WHERE createdAt >= (UTC_TIMESTAMP() - INTERVAL 1 DAY)
      `,
    );

    const out = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalIntegrations: Number(total),
        ordersRowsLast24h_allIntegrations: Number(orders1dTotal?.n ?? 0),
        topUserByCount: top1
          ? { userId: top1.userId, integrationCount: Number(top1.n) }
          : null,
        pathBuckets_byDestinationRows: {
          hammasi_connection,
          aralash,
          faqat_templateConfig_secrets: faqat_legacy,
          boshqa_yoki_manzil_yoq: boshqa,
        },
        integrationsWithOrdersLast24h: integ_with_order_1d,
        note:
          "har bir integratsiya uchun boglangan target_websites: barchasida connectionId bo‘lsa hammasi_connection; kamida bittada templateConfig.secrets va connectionId yoq va boshqa tw da connection bo‘lsa aralash; connectionId hech qayerda bo‘lmasa lekin secrets bo‘lsa faqat_legacy.",
      },
      top25UsersByIntegrationCount: byUser.map((r) => ({
        userId: r.userId,
        n: Number(r.n),
      })),
    };
    if (!summaryOnly) {
      out.integrations = perIntegration;
    }

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

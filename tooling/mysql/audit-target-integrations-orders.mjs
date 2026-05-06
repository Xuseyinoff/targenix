/**
 * Bitta target_websites uchun: integratsiyalar (ustun + join) va orders 24 soat
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const twId = parseInt(process.argv[2] || "60005", 10);
const url =
  process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const c = await mysql.createConnection({ uri: url });

const [fromCol] = await c.query(
  `SELECT id, userId, name, isActive, type, targetWebsiteId, createdAt
     FROM integrations
    WHERE targetWebsiteId = ?`,
  [twId],
);

const [fromJoin] = await c.query(
  `SELECT d.integrationId, i.userId, i.name, i.isActive, i.type, i.targetWebsiteId
     FROM integration_destinations d
     JOIN integrations i ON i.id = d.integrationId
    WHERE d.targetWebsiteId = ? AND d.enabled = 1`,
  [twId],
);

const [fromConfig] = await c.query(
  `SELECT id, userId, name, isActive, type, targetWebsiteId, config
     FROM integrations
    WHERE type = 'LEAD_ROUTING'`,
);
const cfgMatch = [];
for (const row of fromConfig) {
  let cfg;
  try {
    cfg = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  } catch {
    continue;
  }
  const tid = cfg?.targetWebsiteId;
  const n = typeof tid === "string" ? parseInt(tid, 10) : tid;
  if (n === twId) cfgMatch.push({ id: row.id, name: row.name, userId: row.userId });
}

const intIds = new Set();
for (const r of fromCol) intIds.add(r.id);
for (const r of fromJoin) intIds.add(r.integrationId);
for (const r of cfgMatch) intIds.add(r.id);

const ids = [...intIds];
let orders24h = { n: 0 };
let ordersAll = { n: 0 };
if (ids.length) {
  const ph = ids.map(() => "?").join(",");
  const [[o24]] = await c.query(
    `SELECT COUNT(*) AS n FROM orders
      WHERE integrationId IN (${ph})
        AND createdAt >= (UTC_TIMESTAMP() - INTERVAL 1 DAY)`,
    ids,
  );
  orders24h = o24;
  const [[oAll]] = await c.query(
    `SELECT COUNT(*) AS n FROM orders WHERE integrationId IN (${ph})`,
    ids,
  );
  ordersAll = oAll;
}

console.log(
  JSON.stringify(
    {
      targetWebsiteId: twId,
      integrations_targetWebsiteId_column: fromCol,
      count_column: fromCol.length,
      integration_destinations_enabled: fromJoin,
      count_join: fromJoin.length,
      config_json_targetWebsiteId_60005_only: cfgMatch,
      count_config_match: cfgMatch.length,
      distinct_integration_ids: [...intIds].sort((a, b) => a - b),
      distinct_count: intIds.size,
      orders_last_24h: orders24h.n,
      orders_all_time: ordersAll.n,
      note:
        "orders jadvalida targetWebsiteId yo'q; integrationId orqali hisoblandi",
    },
    null,
    2,
  ),
);

await c.end();

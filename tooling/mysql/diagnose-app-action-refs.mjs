/**
 * Find what's referencing app_actions and why jobs fail.
 * Usage: railway run node tooling/mysql/diagnose-app-action-refs.mjs
 */
import mysql from "mysql2/promise";

function getMysqlUrl() {
  for (const raw of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

async function main() {
  const cn = await mysql.createConnection(getMysqlUrl());
  try {
    // 1. Check destination_templates referencing app_actions
    const [dtRefs] = await cn.query(`
      SELECT dt.id, dt.appKey, dt.actionKey, dt.name
      FROM destination_templates dt
      WHERE dt.actionKey IS NOT NULL
      LIMIT 20
    `).catch(() => [[]]);
    console.log("destination_templates with actionKey:", dtRefs);

    // 2. Check integration_destinations
    const [idCols] = await cn.query(`SHOW COLUMNS FROM integration_destinations`);
    console.log("\nintegration_destinations columns:", idCols.map(c => c.Field));

    // 3. Check target_websites with appActionId or similar
    const [twCols] = await cn.query(`SHOW COLUMNS FROM target_websites`);
    console.log("\ntarget_websites columns:", twCols.map(c => c.Field));

    // 4. Find who queries app_actions.id=5
    const [tw5] = await cn.query(`SELECT id, userId, templateType, templateConfig FROM target_websites WHERE JSON_EXTRACT(templateConfig, '$.appActionId') = 5 LIMIT 5`).catch(() => [[]]);
    console.log("\ntarget_websites with appActionId=5:", tw5);

    // 5. Direct app_actions table state
    const [[cnt]] = await cn.query(`SELECT COUNT(*) as n FROM app_actions`);
    console.log("\napp_actions total rows:", cnt.n);
  } finally {
    await cn.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });

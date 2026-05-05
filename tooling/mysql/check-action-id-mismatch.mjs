import mysql from "mysql2/promise";
function getUrl() {
  for (const r of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = r?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
}
const cn = await mysql.createConnection(getUrl());

// app_actions that exist
const [actions] = await cn.query("SELECT id, appKey, actionKey, name FROM app_actions ORDER BY id");
console.log("app_actions rows:", actions);

// target_websites actionId values
const [tw] = await cn.query("SELECT id, userId, appKey, actionId, templateType FROM target_websites WHERE actionId IS NOT NULL ORDER BY actionId");
console.log("\ntarget_websites with actionId:", tw);

// Missing: actionIds in target_websites not in app_actions
const actionIds = new Set(actions.map(r => r.id));
const missing = tw.filter(r => !actionIds.has(r.actionId));
console.log("\nMISSING (actionId not in app_actions):", missing.length, "rows");
if (missing.length) console.log("Sample:", missing.slice(0,5));

await cn.end();

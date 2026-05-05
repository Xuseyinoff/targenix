import mysql from "mysql2/promise";
function getUrl() {
  for (const r of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = r?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
}
const cn = await mysql.createConnection(getUrl());

// Full column list
const [cols] = await cn.query("SHOW FULL COLUMNS FROM app_actions");
console.log("Columns:", cols.map(c => `${c.Field} ${c.Type} NULL=${c.Null} DEFAULT=${c.Default}`));

// Row id=5 raw data
const [rows] = await cn.query("SELECT * FROM app_actions WHERE id = 5");
const r = rows[0];
console.log("\nRow id=5:");
for (const [k, v] of Object.entries(r || {})) {
  const val = typeof v === 'string' && v.length > 80 ? v.substring(0,80)+'...' : v;
  console.log(`  ${k}: ${JSON.stringify(val)}`);
}

// Try the exact Drizzle query
try {
  const [test] = await cn.query(
    "SELECT `id`, `appKey`, `actionKey`, `name`, `endpointUrl`, `method`, `contentType`, `bodyFields`, `userFields`, `variableFields`, `autoMappedFields`, `schemaVersion`, `inputSchema`, `outputSchema`, `uiSchema`, `isDefault`, `isActive`, `createdAt` FROM `app_actions` WHERE `app_actions`.`id` = ? LIMIT ?",
    [5, 1]
  );
  console.log("\nDirect query result:", test.length, "rows — OK");
} catch(e) {
  console.error("\nDirect query FAILED:", e.message);
}

await cn.end();

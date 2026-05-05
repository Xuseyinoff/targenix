import mysql from "mysql2/promise";
function getUrl() {
  for (const r of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = r?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
}
const cn = await mysql.createConnection(getUrl());

const cols = ["schemaVersion", "inputSchema", "outputSchema", "uiSchema"];
const [existing] = await cn.query("SHOW COLUMNS FROM app_actions");
const existingNames = new Set(existing.map(c => c.Field));

for (const col of cols) {
  if (existingNames.has(col)) {
    console.log(`– ${col} already exists, skip`);
    continue;
  }
  if (col === "schemaVersion") {
    await cn.query(`ALTER TABLE app_actions ADD COLUMN schemaVersion INT NOT NULL DEFAULT 1 AFTER autoMappedFields`);
  } else {
    await cn.query(`ALTER TABLE app_actions ADD COLUMN ${col} JSON NULL AFTER schemaVersion`);
  }
  console.log(`✓ ${col} added`);
}

console.log("\nDone. Testing query...");
const [rows] = await cn.query(
  "SELECT `id`,`appKey`,`actionKey`,`name`,`endpointUrl`,`method`,`contentType`,`bodyFields`,`userFields`,`variableFields`,`autoMappedFields`,`schemaVersion`,`inputSchema`,`outputSchema`,`uiSchema`,`isDefault`,`isActive`,`createdAt` FROM `app_actions` WHERE id = 5 LIMIT 1"
);
console.log("Query OK, row:", rows[0]?.name);

await cn.end();

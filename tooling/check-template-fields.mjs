import "dotenv/config";
import mysql from "mysql2/promise";
const url = process.env.MYSQL_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) { console.error("Set MYSQL_PUBLIC_URL or DATABASE_URL"); process.exit(1); }
const c = await mysql.createConnection(url);
const [rows] = await c.execute(
  "SELECT id, name, variableFields, autoMappedFields, userVisibleFields FROM destination_templates WHERE isActive = 1 ORDER BY id"
);
for (const r of rows) {
  const vf = typeof r.variableFields === "string" ? JSON.parse(r.variableFields) : r.variableFields;
  const af = typeof r.autoMappedFields === "string" ? JSON.parse(r.autoMappedFields) : r.autoMappedFields;
  const uf = typeof r.userVisibleFields === "string" ? JSON.parse(r.userVisibleFields) : r.userVisibleFields;
  console.log(`#${r.id} ${r.name}`);
  console.log(`   variableFields:    ${JSON.stringify(vf)}`);
  console.log(`   autoMappedFields:  ${JSON.stringify(af)}`);
  console.log(`   userVisibleFields: ${JSON.stringify(uf)}`);
}
await c.end();

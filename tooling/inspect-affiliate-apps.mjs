/**
 * One-shot read-only inspector for the affiliate apps + templates.
 * Run with: node tooling/inspect-affiliate-apps.mjs
 *
 * Reads MYSQL_PUBLIC_URL from the Railway env so we don't store the URL
 * in source. Prints `apps` rows + their linked `destination_templates`
 * so we can see what shape new-affiliate UX needs to match.
 */
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL;
if (!url) {
  console.error("MYSQL_PUBLIC_URL not set. Run via: railway run --service targenix.uz node tooling/inspect-affiliate-apps.mjs");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

const [apps] = await conn.execute(
  "SELECT id, appKey, displayName, category, authType, fields, iconUrl, isActive FROM apps ORDER BY id ASC",
);

console.log("\n═══ apps (catalog) ═══");
for (const a of apps) {
  console.log(`\n  id=${a.id}  appKey=${a.appKey}  displayName=${a.displayName}`);
  console.log(`    category=${a.category}  authType=${a.authType}  isActive=${a.isActive}`);
  console.log(`    fields=${JSON.stringify(a.fields)}`);
  console.log(`    iconUrl=${a.iconUrl}`);
}

const [templates] = await conn.execute(
  `SELECT id, name, appKey, category, endpointUrl, method, contentType,
          bodyFields, userVisibleFields, variableFields, autoMappedFields,
          isActive, createdAt
   FROM destination_templates
   ORDER BY appKey, id ASC`,
);

console.log("\n\n═══ destination_templates ═══");
for (const t of templates) {
  console.log(`\n  id=${t.id}  name=${t.name}  appKey=${t.appKey}  category=${t.category}  active=${t.isActive}`);
  console.log(`    ${t.method} ${t.endpointUrl}`);
  console.log(`    contentType=${t.contentType}`);
  console.log(`    bodyFields=${JSON.stringify(t.bodyFields)}`);
  console.log(`    userVisibleFields=${JSON.stringify(t.userVisibleFields)}`);
  console.log(`    variableFields=${JSON.stringify(t.variableFields)}`);
  console.log(`    autoMappedFields=${JSON.stringify(t.autoMappedFields)}`);
}

console.log(`\n\nTotals: apps=${apps.length}, templates=${templates.length}\n`);

await conn.end();

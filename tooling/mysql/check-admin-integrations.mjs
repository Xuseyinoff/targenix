import mysql from "mysql2/promise";

// Try public URL first (for local railway run), then internal
const urls = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_PUBLIC_URL,
  process.env.MYSQL_URL,
  process.env.DATABASE_URL,
].filter(Boolean);

let cn;
for (const url of urls) {
  try {
    cn = await mysql.createConnection(url);
    break;
  } catch {}
}
if (!cn) { console.error("No DB reachable"); process.exit(1); }

const [pages] = await cn.query("SELECT pageId, pageName FROM facebook_connections WHERE userId = 1 LIMIT 20");
console.log("userId=1 connected pages:", pages.length);
pages.forEach(p => console.log(" ", p.pageId, p.pageName));

const [intg] = await cn.query("SELECT id, name, pageId, formId, isActive FROM integrations WHERE userId = 1 AND type = 'LEAD_ROUTING' LIMIT 20");
console.log("\nuserId=1 LEAD_ROUTING integrations:", intg.length);
intg.forEach(i => console.log(" ", i.id, i.name, "active:", i.isActive));

const [orders1] = await cn.query("SELECT COUNT(*) as cnt FROM orders WHERE userId = 1");
console.log("\nuserId=1 total orders:", orders1[0].cnt);

await cn.end();

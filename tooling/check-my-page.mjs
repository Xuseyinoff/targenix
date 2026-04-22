import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// Check if userId=1 has any connection to pageId 1058919167311236
const [fbConns] = await conn.execute(`
  SELECT fc.*
  FROM facebook_connections fc
  WHERE fc.pageId = '1058919167311236'
`);
console.log("=== FB CONNECTIONS for page 1058919167311236 ===");
for (const r of fbConns) console.log(JSON.stringify(r));

// Check integrations for userId=1 with this page
const [integ] = await conn.execute(`
  SELECT id, userId, name, type, pageId, formId
  FROM integrations
  WHERE pageId = '1058919167311236'
`);
console.log("\n=== INTEGRATIONS for page 1058919167311236 ===");
for (const r of integ) console.log(JSON.stringify(r));

// Check leads for userId=1 with this page today
const [myLeads] = await conn.execute(`
  SELECT id, userId, fullName, phone, pageId, formId, deliveryStatus, createdAt
  FROM leads
  WHERE pageId = '1058919167311236' AND createdAt > '2026-04-16 00:00:00'
  ORDER BY createdAt DESC
  LIMIT 10
`);
console.log("\n=== TODAY'S LEADS for page 1058919167311236 ===");
for (const r of myLeads) console.log(JSON.stringify(r));

await conn.end();

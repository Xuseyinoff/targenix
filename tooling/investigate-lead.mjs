import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

const userId = 1893631;
const leadId = 8266218;
const formId = "1795576241399871";
const pageId = "1058919167311236";

// 1. Integration details with target website
console.log("=== 1. INTEGRATION (Nicor) ===");
const [integ] = await conn.execute(`
  SELECT i.*
  FROM integrations i
  WHERE i.userId = ? AND i.formId = ?
`, [userId, formId]);
for (const r of integ) console.log(JSON.stringify(r, null, 2));

// 2. Target website (destination) for this integration
if (integ.length > 0 && integ[0].targetWebsiteId) {
  const [tw] = await conn.execute(`
    SELECT * FROM target_websites WHERE id = ?
  `, [integ[0].targetWebsiteId]);
  console.log("\n=== 2. TARGET WEBSITE (Destination) ===");
  for (const r of tw) console.log(JSON.stringify(r, null, 2));
}

// 3. All target websites for this user
console.log("\n=== 3. ALL TARGET WEBSITES for userId=" + userId + " ===");
const [allTw] = await conn.execute(`
  SELECT id, userId, name, url, apiKey, telegramChatId, createdAt
  FROM target_websites
  WHERE userId = ?
`, [userId]);
for (const r of allTw) console.log(JSON.stringify(r, null, 2));

// 4. All target websites for userId=1 (your account)
console.log("\n=== 4. YOUR TARGET WEBSITES (userId=1) ===");
const [myTw] = await conn.execute(`
  SELECT id, userId, name, url, apiKey, telegramChatId, createdAt
  FROM target_websites
  WHERE userId = 1
`);
for (const r of myTw) console.log(JSON.stringify(r, null, 2));

// 5. Check lead delivery log / orders for this lead
console.log("\n=== 5. ORDERS for leadId=" + leadId + " ===");
const [orders] = await conn.execute(`
  SELECT * FROM orders WHERE leadId = ?
`, [leadId]);
for (const r of orders) console.log(JSON.stringify(r, null, 2));

// 6. Check how delivery works - look at lead's full record
console.log("\n=== 6. FULL LEAD RECORD ===");
const [lead] = await conn.execute(`
  SELECT * FROM leads WHERE id = ?
`, [leadId]);
for (const r of lead) console.log(JSON.stringify(r, null, 2));

await conn.end();

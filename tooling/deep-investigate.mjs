import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// 1. Check if this SAME leadgenId exists for userId=1
console.log("=== 1. SAME LEADGEN ID FOR userId=1? ===");
const [dupes] = await conn.execute(`
  SELECT id, userId, leadgenId, fullName, phone, pageId, formId, dataStatus, deliveryStatus, createdAt
  FROM leads 
  WHERE leadgenId = '1493696892424492'
  ORDER BY userId
`);
for (const r of dupes) console.log(JSON.stringify(r, null, 2));

// 2. Check if the SAME phone appeared for userId=1 today
console.log("\n=== 2. PHONE +998913006881 FOR userId=1? ===");
const [phoneLeads] = await conn.execute(`
  SELECT id, userId, leadgenId, fullName, phone, pageId, formId, dataStatus, deliveryStatus, createdAt
  FROM leads 
  WHERE phone LIKE '%913006881%' AND userId = 1
`);
for (const r of phoneLeads) console.log(JSON.stringify(r, null, 2));
if (phoneLeads.length === 0) console.log("  None found");

// 3. Check ALL orders related to leadgenId 1493696892424492
console.log("\n=== 3. ALL ORDERS for leadgenId=1493696892424492 ===");
const [allOrders] = await conn.execute(`
  SELECT o.*, l.userId AS leadUserId
  FROM orders o
  JOIN leads l ON l.id = o.leadId
  WHERE l.leadgenId = '1493696892424492'
`);
for (const r of allOrders) console.log(JSON.stringify(r, null, 2));

// 4. Check if userId=1 has ANY integration for pageId 1058919167311236
console.log("\n=== 4. userId=1 INTEGRATIONS for pageId=1058919167311236 ===");
const [myInteg] = await conn.execute(`
  SELECT * FROM integrations WHERE userId = 1 AND pageId = '1058919167311236'
`);
for (const r of myInteg) console.log(JSON.stringify(r, null, 2));
if (myInteg.length === 0) console.log("  None found");

// 5. Check facebook_connections — does userId=1 have this page connected?
console.log("\n=== 5. userId=1 FB CONNECTION for pageId=1058919167311236 ===");
const [myFbConn] = await conn.execute(`
  SELECT * FROM facebook_connections WHERE userId = 1 AND pageId = '1058919167311236'
`);
for (const r of myFbConn) console.log(JSON.stringify(r, null, 2));
if (myFbConn.length === 0) console.log("  None found");

// 6. Who subscribes to webhook for this page? Check all facebook_connections for this page
console.log("\n=== 6. ALL FB CONNECTIONS for pageId=1058919167311236 ===");
const [allFbConn] = await conn.execute(`
  SELECT id, userId, pageId, pageName, isActive, subscriptionStatus FROM facebook_connections WHERE pageId = '1058919167311236'
`);
for (const r of allFbConn) console.log(JSON.stringify(r, null, 2));

// 7. Check your (userId=1) orders around 12:48 (the time shown in notification)
console.log("\n=== 7. userId=1 ORDERS around 2026-04-15 12:48 (±5 min) ===");
const [myOrders] = await conn.execute(`
  SELECT o.id, o.leadId, o.userId, o.integrationId, o.status, o.responseData, o.createdAt
  FROM orders o
  WHERE o.userId = 1 
    AND o.createdAt BETWEEN '2026-04-15 12:40:00' AND '2026-04-15 12:55:00'
  ORDER BY o.createdAt
`);
for (const r of myOrders) console.log(JSON.stringify(r, null, 2));
if (myOrders.length === 0) console.log("  None found");

// 8. The earlier duplicate lead (id=8259352, same phone, userId=1864938) — check orders
console.log("\n=== 8. EARLIER LEAD id=8259352 (Ismoil same phone, Apr 15 14:48) ===");
const [earlierOrders] = await conn.execute(`
  SELECT o.*, l.userId AS leadUserId, l.pageId, l.formId
  FROM orders o
  JOIN leads l ON l.id = o.leadId
  WHERE o.leadId = 8259352
`);
for (const r of earlierOrders) console.log(JSON.stringify(r, null, 2));

// 9. Check if there's a lead for userId=1 with same phone from Apr 15
console.log("\n=== 9. userId=1 LEADS with phone 913006881 (all time) ===");
const [myPhoneLeads] = await conn.execute(`
  SELECT l.id, l.userId, l.leadgenId, l.fullName, l.phone, l.pageId, l.formId, l.deliveryStatus, l.createdAt,
         (SELECT GROUP_CONCAT(o.id) FROM orders o WHERE o.leadId = l.id) AS orderIds
  FROM leads l
  WHERE l.userId = 1 AND l.phone LIKE '%913006881%'
`);
for (const r of myPhoneLeads) console.log(JSON.stringify(r, null, 2));
if (myPhoneLeads.length === 0) console.log("  None found");

// 10. Check the lead dispatch code — how does it decide which userId gets the lead?
console.log("\n=== 10. LEAD DISPATCH: How leadgenId=1493696892424492 was routed ===");
const [dispatchLog] = await conn.execute(`
  SELECT * FROM app_logs 
  WHERE (message LIKE '%1493696892424492%' OR message LIKE '%8266218%')
  ORDER BY createdAt DESC
  LIMIT 20
`);
for (const r of dispatchLog) console.log(JSON.stringify({id: r.id, category: r.category, message: r.message, metadata: r.metadata, createdAt: r.createdAt}, null, 2));
if (dispatchLog.length === 0) console.log("  No logs found");

await conn.end();

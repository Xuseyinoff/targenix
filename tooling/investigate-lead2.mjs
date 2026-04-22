import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// 1. Target website id=60014 (from integration config)
console.log("=== 1. TARGET WEBSITE id=60014 ===");
const [tw] = await conn.execute(`SELECT * FROM target_websites WHERE id = 60014`);
for (const r of tw) console.log(JSON.stringify(r, null, 2));

// 2. All target_websites columns
console.log("\n=== 2. TARGET_WEBSITES TABLE STRUCTURE ===");
const [cols] = await conn.execute(`DESCRIBE target_websites`);
for (const c of cols) console.log(`  ${c.Field} (${c.Type}) ${c.Null === 'YES' ? 'nullable' : 'NOT NULL'} ${c.Default ? 'default=' + c.Default : ''}`);

// 3. Ruslan's ALL target websites
console.log("\n=== 3. RUSLAN's TARGET WEBSITES (userId=1893631) ===");
const [rTw] = await conn.execute(`SELECT * FROM target_websites WHERE userId = 1893631`);
for (const r of rTw) console.log(JSON.stringify(r, null, 2));

// 4. YOUR target websites (userId=1)
console.log("\n=== 4. YOUR TARGET WEBSITES (userId=1) ===");
const [myTw] = await conn.execute(`SELECT * FROM target_websites WHERE userId = 1`);
for (const r of myTw) console.log(JSON.stringify(r, null, 2));

// 5. Orders for this lead
console.log("\n=== 5. ORDERS for leadId=8266218 ===");
const [orders] = await conn.execute(`SELECT * FROM orders WHERE leadId = 8266218`);
if (orders.length === 0) console.log("  No orders found");
for (const r of orders) console.log(JSON.stringify(r, null, 2));

// 6. Full lead record
console.log("\n=== 6. FULL LEAD id=8266218 ===");
const [lead] = await conn.execute(`SELECT * FROM leads WHERE id = 8266218`);
for (const r of lead) console.log(JSON.stringify(r, null, 2));

await conn.end();

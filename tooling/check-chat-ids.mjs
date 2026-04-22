import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// Your (userId=1) telegram info
console.log("=== YOUR TELEGRAM INFO (userId=1) ===");
const [you] = await conn.execute(`SELECT id, telegramChatId, telegramUsername FROM users WHERE id = 1`);
console.log(JSON.stringify(you[0]));

// Your delivery chats
console.log("\n=== YOUR DELIVERY CHATS (telegram_chats for userId=1) ===");
const [yourChats] = await conn.execute(`SELECT * FROM telegram_chats WHERE userId = 1`);
for (const r of yourChats) console.log(JSON.stringify(r));

// Your target_websites telegramChatIds
console.log("\n=== YOUR DESTINATION TELEGRAM CHAT IDS ===");
const [yourTw] = await conn.execute(`SELECT id, name, telegramChatId FROM target_websites WHERE userId = 1`);
for (const r of yourTw) console.log(JSON.stringify(r));

// Ruslan's telegram info
console.log("\n=== RUSLAN TELEGRAM INFO (userId=1893631) ===");
const [ruslan] = await conn.execute(`SELECT id, telegramChatId, telegramUsername FROM users WHERE id = 1893631`);
console.log(JSON.stringify(ruslan[0]));

// Ruslan's delivery chats
console.log("\n=== RUSLAN DELIVERY CHATS ===");
const [ruslanChats] = await conn.execute(`SELECT * FROM telegram_chats WHERE userId = 1893631`);
for (const r of ruslanChats) console.log(JSON.stringify(r));

// Ruslan's target_websites
console.log("\n=== RUSLAN DESTINATION TELEGRAM CHAT IDS ===");
const [ruslanTw] = await conn.execute(`SELECT id, name, telegramChatId FROM target_websites WHERE userId = 1893631`);
for (const r of ruslanTw) console.log(JSON.stringify(r));

// KEY CHECK: Is Ruslan's destination telegramChatId (-5247092518) the same as any of YOUR chats?
console.log("\n=== CROSS-CHECK: Does -5247092518 belong to you? ===");
const [match] = await conn.execute(`
  SELECT 'telegram_chats' AS source, chatId, userId FROM telegram_chats WHERE chatId = '-5247092518'
  UNION ALL
  SELECT 'target_websites', telegramChatId, userId FROM target_websites WHERE telegramChatId = '-5247092518'
  UNION ALL
  SELECT 'users', telegramChatId, id FROM users WHERE telegramChatId = '-5247092518'
`);
for (const r of match) console.log(JSON.stringify(r));

await conn.end();

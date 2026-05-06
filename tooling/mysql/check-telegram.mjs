import mysql from "mysql2/promise";
const urls = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL].filter(Boolean);
let cn;
for (const url of urls) { try { cn = await mysql.createConnection(url); break; } catch {} }
if (!cn) { console.error("No DB"); process.exit(1); }
const q = async (sql) => { const [r] = await cn.query(sql); return r; };

// 1. Foydalanuvchilar Telegram ulagan, lekin integratsiyalarida chatId yo'q
const [usersConnected] = await cn.query(`
  SELECT
    u.id, u.email,
    u.telegramChatId IS NOT NULL AND u.telegramChatId != '' as hasSysChat,
    u.telegramDestinationDefaultChatId IS NOT NULL AND u.telegramDestinationDefaultChatId != '' as hasDefaultDelivery,
    COUNT(i.id) as totalIntg,
    SUM(i.telegramChatId IS NOT NULL AND i.telegramChatId != '') as intgWithChat,
    SUM(i.telegramChatId IS NULL OR i.telegramChatId = '') as intgWithoutChat
  FROM users u
  JOIN integrations i ON i.userId = u.id AND i.type = 'LEAD_ROUTING' AND i.isActive = 1
  WHERE u.telegramChatId IS NOT NULL AND u.telegramChatId != ''
  GROUP BY u.id, u.email, u.telegramChatId, u.telegramDestinationDefaultChatId
`);

console.log("\n══ Telegram ulagan foydalanuvchilar va integratsiyalar ══════════\n");
console.log(`${"Email".padEnd(42)} ${"SysChat".padEnd(10)} ${"DefDeliv".padEnd(10)} ${"Intg".padEnd(6)} ${"w/Chat".padEnd(8)} ${"w/o Chat"}`);
console.log("─".repeat(90));

let totalIntgWithChat = 0, totalIntgWithout = 0;
for (const r of usersConnected) {
  const hasChat = Number(r.intgWithChat);
  const noChat = Number(r.intgWithoutChat);
  totalIntgWithChat += hasChat;
  totalIntgWithout += noChat;
  const flag = noChat > 0 ? " ⚠" : " ✓";
  console.log(
    `${String(r.email || "—").padEnd(42)} ${String(r.hasSysChat ? "✓" : "✗").padEnd(10)} ${String(r.hasDefaultDelivery ? "✓" : "✗").padEnd(10)} ${String(r.totalIntg).padEnd(6)} ${String(hasChat).padEnd(8)} ${noChat}${flag}`
  );
}

console.log("─".repeat(90));
console.log(`\nJami: ${usersConnected.length} ta foydalanuvchi Telegram ulagan`);
console.log(`  Integratsiyalarida chatId bor:  ${totalIntgWithChat} ta → Telegram xabari ketadi ✓`);
console.log(`  Integratsiyalarida chatId yo'q: ${totalIntgWithout} ta → Xabar KETMAYDI ⚠`);

// 2. So'nggi 24h Telegram yuborilgan/yuborilmagan
const [tgSent] = await cn.query(`
  SELECT COUNT(*) as cnt FROM orders o
  JOIN integrations i ON i.id = o.integrationId
  WHERE o.status = 'SENT'
    AND o.createdAt >= NOW() - INTERVAL 24 HOUR
    AND i.telegramChatId IS NOT NULL AND i.telegramChatId != ''
`);
const [tgNoChat] = await cn.query(`
  SELECT COUNT(*) as cnt FROM orders o
  JOIN integrations i ON i.id = o.integrationId
  WHERE o.status = 'SENT'
    AND o.createdAt >= NOW() - INTERVAL 24 HOUR
    AND (i.telegramChatId IS NULL OR i.telegramChatId = '')
`);

console.log(`\n══ So'nggi 24h SENT orderlar ════════════════════════════════════`);
console.log(`  Telegram xabari yuborilgan (chatId bor): ${tgSent[0].cnt} ta ✓`);
console.log(`  Telegram xabari ketmagan  (chatId yo'q): ${tgNoChat[0].cnt} ta`);

// 3. telegram_chats jadvali
const chats = await q(`
  SELECT type, COUNT(*) as cnt FROM telegram_chats
  WHERE disconnectedAt IS NULL
  GROUP BY type
`);
console.log(`\n══ Ulangan Telegram chatlar ════════════════════════════════════`);
chats.forEach(r => console.log(`  ${r.type}: ${r.cnt} ta`));

await cn.end();
console.log();

import mysql from "mysql2/promise";
const urls = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL].filter(Boolean);
let cn; for (const u of urls) { try { cn = await mysql.createConnection(u); break; } catch {} }

// target_websites with telegramChatId
const [twAll] = await cn.query("SELECT COUNT(*) as total, SUM(telegramChatId IS NOT NULL AND telegramChatId != '') as withChat FROM target_websites");
console.log(`\ntarget_websites: ${twAll[0].total} ta, chatId bor: ${twAll[0].withChat} ta`);

// Show which target_websites have chatId and their usage in 24h
const [twList] = await cn.query(`
  SELECT tw.id, tw.name, tw.telegramChatId,
    COUNT(o.id) as orders24h,
    SUM(o.status = 'SENT') as sent24h
  FROM target_websites tw
  LEFT JOIN integrations i ON i.targetWebsiteId = tw.id AND i.isActive = 1
  LEFT JOIN orders o ON o.integrationId = i.id AND o.createdAt >= NOW() - INTERVAL 24 HOUR
  WHERE tw.telegramChatId IS NOT NULL AND tw.telegramChatId != ''
  GROUP BY tw.id, tw.name, tw.telegramChatId
`);
console.log("\nTelegram chatId bor target_websites (24h orderlar bilan):");
twList.forEach(r =>
  console.log(`  id=${r.id} "${r.name}" chatId=${r.telegramChatId} → orders=${r.orders24h} sent=${r.sent24h}`)
);

// REAL check: 24h SENT orders where target_website has chatId
const [withTg] = await cn.query(`
  SELECT COUNT(*) as cnt
  FROM orders o
  JOIN integrations i ON i.id = o.integrationId
  JOIN target_websites tw ON tw.id = i.targetWebsiteId
  WHERE o.status = 'SENT'
    AND o.createdAt >= NOW() - INTERVAL 24 HOUR
    AND tw.telegramChatId IS NOT NULL AND tw.telegramChatId != ''
`);
const [noTg] = await cn.query(`
  SELECT COUNT(*) as cnt
  FROM orders o
  JOIN integrations i ON i.id = o.integrationId
  LEFT JOIN target_websites tw ON tw.id = i.targetWebsiteId
  WHERE o.status = 'SENT'
    AND o.createdAt >= NOW() - INTERVAL 24 HOUR
    AND (tw.telegramChatId IS NULL OR tw.telegramChatId = '' OR tw.id IS NULL)
`);

console.log(`\n══ So'nggi 24h SENT orderlar (to'g'ri tekshiruv) ══════════`);
console.log(`  Telegram xabari ketgan  (target_website chatId bor): ${withTg[0].cnt} ta ${withTg[0].cnt > 0 ? '✓' : '⚠'}`);
console.log(`  Telegram xabari ketmagan (chatId yo'q):              ${noTg[0].cnt} ta`);

// Per user: telegram_chats DELIVERY vs target_website chatId match
const [delivery] = await cn.query(`
  SELECT u.email, tc.chatId, tc.title, tc.type
  FROM telegram_chats tc
  JOIN users u ON u.id = tc.userId
  WHERE tc.disconnectedAt IS NULL
`);
console.log(`\n══ Ulangan Telegram chatlar (telegram_chats jadval) ════════`);
delivery.forEach(r => console.log(`  ${r.type.padEnd(10)} chatId=${r.chatId} "${r.title||'(shaxsiy)'}" — ${r.email}`));

await cn.end();

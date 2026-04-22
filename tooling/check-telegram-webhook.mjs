const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set"); process.exit(1); }

// 1. getWebhookInfo
const wh = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
const whData = await wh.json();
console.log("\n=== Webhook Info ===");
console.log(JSON.stringify(whData, null, 2));

// 2. getMe — bot info
const me = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
const meData = await me.json();
console.log("\n=== Bot Info ===");
console.log(JSON.stringify(meData, null, 2));

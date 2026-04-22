const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set"); process.exit(1); }

const correctUrl = "https://targenix.uz/api/telegram/webhook";

console.log(`Setting webhook to: ${correctUrl}`);

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: correctUrl,
    allowed_updates: ["message", "my_chat_member"],
  }),
});
const data = await res.json();
console.log("Result:", JSON.stringify(data, null, 2));

// Verify
const wh = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
const whData = await wh.json();
console.log("\nVerify:", whData.result?.url);

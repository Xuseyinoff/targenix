import mysql from "mysql2/promise";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

if (!url) { console.error("No DB URL"); process.exit(1); }
const conn = await mysql.createConnection(url);

// 1. Telegramga ulangan va ulanmagan userlar
console.log("\n=== Telegram connection holati ===\n");
const [stats] = await conn.query(`
  SELECT
    CASE WHEN telegramChatId IS NOT NULL THEN 'connected' ELSE 'not_connected' END as status,
    COUNT(*) as cnt
  FROM users
  GROUP BY status
`);
console.table(stats);

// 2. Hozir telegramConnectToken saqlangan userlar (token yaratilgan, lekin hali ishlatilmagan)
const [pendingTokens] = await conn.query(`
  SELECT id, email, name,
    LEFT(telegramConnectToken, 12) as token_preview,
    LENGTH(telegramConnectToken) as token_len,
    telegramChatId,
    telegramUsername,
    telegramConnectedAt,
    updatedAt
  FROM users
  WHERE telegramConnectToken IS NOT NULL
  ORDER BY updatedAt DESC
  LIMIT 20
`);
console.log("\n=== Active (pending) connect tokens ===\n");
console.table(pendingTokens);

// 3. Oxirgi ulanishga uringan userlar (token yaratilgan lekin chatId null)
const [recentFailed] = await conn.query(`
  SELECT id, email, name,
    CASE WHEN telegramConnectToken IS NOT NULL THEN 'HAS_TOKEN' ELSE 'NO_TOKEN' END as token_status,
    telegramChatId,
    telegramUsername,
    updatedAt
  FROM users
  WHERE telegramChatId IS NULL
    AND updatedAt >= NOW() - INTERVAL 24 HOUR
  ORDER BY updatedAt DESC
  LIMIT 20
`);
console.log("\n=== Oxirgi 24 soat: Telegram ulanmagan userlar ===\n");
console.table(recentFailed);

// 4. telegramConnectToken ustuni bor-yo'qligini tekshirish
const [columns] = await conn.query(`
  SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'users'
    AND COLUMN_NAME LIKE 'telegram%'
  ORDER BY ORDINAL_POSITION
`);
console.log("\n=== users jadvalidagi telegram ustunlari ===\n");
console.table(columns);

await conn.end();

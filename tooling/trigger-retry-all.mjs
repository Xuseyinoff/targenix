/**
 * Admin tRPC orqali retryAll trigger qilish
 * Bu web service ichida chaqiriladi — u BullMQ ga joylaydi, worker ishlatadi
 */
import mysql from "mysql2/promise";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

if (!url) { console.error("❌ DB URL topilmadi"); process.exit(1); }

// DB dan admin user olish (login qilish uchun)
const conn = await mysql.createConnection(url);
const [[adminUser]] = await conn.query(
  `SELECT id, email FROM users WHERE isAdmin = 1 LIMIT 1`
);
await conn.end();

if (!adminUser) { console.error("❌ Admin user topilmadi"); process.exit(1); }
console.log(`Admin user: ${adminUser.email} (id=${adminUser.id})`);

// Web service URL
const APP_URL = process.env.APP_URL || "https://targenix.uz";

// tRPC retryAll chaqirish
const response = await fetch(`${APP_URL}/api/trpc/adminLeads.retryAll`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    // Admin autentifikatsiya uchun cookie kerak - buni CLI dan chaqirib bo'lmaydi
    // Shuning uchun to'g'ridan to'g'ri DB va BullMQ orqali qilamiz
  },
  body: JSON.stringify({ json: null }),
});

const text = await response.text();
console.log("Response status:", response.status);
console.log("Response:", text.substring(0, 500));

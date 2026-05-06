/**
 * Real test: Sotuvchi /getOrders pagination
 * Usage: railway run --service MySQL node tooling/mysql/test-sotuvchi-pagination.mjs
 */
import mysql from "mysql2/promise";

const urls = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL].filter(Boolean);
let cn;
for (const u of urls) { try { cn = await mysql.createConnection(u); break; } catch {} }
if (!cn) { console.error("No DB reachable"); process.exit(1); }

// 1. Get active Sotuvchi bearer token from DB
const [rows] = await cn.query(
  "SELECT bearerTokenEncrypted, phone, platformUserId, status FROM crm_connections WHERE platform = 'sotuvchi' LIMIT 1"
);
await cn.end();

if (!rows.length) { console.error("Sotuvchi CRM connection topilmadi"); process.exit(1); }

const row = rows[0];
console.log(`CRM account: ${row.phone} | status: ${row.status} | platformUserId: ${row.platformUserId}`);

// 2. Decrypt token (simple XOR decrypt — matches server/encryption.ts pattern)
// Actually we need the real encryption key. Let's use the env var approach instead.
// The token is encrypted with AES. We'll call the login endpoint fresh instead.

// Check if ENCRYPTION_KEY is available
if (!process.env.ENCRYPTION_KEY && !process.env.DATABASE_URL) {
  console.log("\nToken encrypted in DB — need ENCRYPTION_KEY to decrypt.");
  console.log("Trying direct login with stored credentials...");
}

// Re-login to get fresh token
const SOTUVCHI_BASE = "https://apiv3.sotuvchi.com/api";

// Get password from env or ask user to set it
const email = process.env.SOTUVCHI_EMAIL || row.phone;
const password = process.env.SOTUVCHI_PASSWORD;

if (!password) {
  console.error("\nSOTUVCHI_PASSWORD env var kerak. Railway'da set qiling yoki:");
  console.error("SOTUVCHI_PASSWORD=yourpass railway run --service MySQL node tooling/mysql/test-sotuvchi-pagination.mjs");
  process.exit(1);
}

console.log(`\nLogging in as: ${email}`);

const loginRes = await fetch(`${SOTUVCHI_BASE}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Accept": "application/json", "Accept-Language": "uz" },
  body: JSON.stringify({ email, password }),
});

const loginData = await loginRes.json();
if (!loginData.token) {
  console.error("Login failed:", JSON.stringify(loginData));
  process.exit(1);
}

const token = loginData.token;
console.log(`✓ Login OK | token: ${token.slice(0, 20)}...`);

// 3. Fetch page 1 with limit 5 to see structure
console.log("\n─── GET /getOrders?page=1&limit=5 ───");
const ordersRes = await fetch(`${SOTUVCHI_BASE}/getOrders?page=1&limit=5`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Language": "uz" },
});

const ordersData = await ordersRes.json();

console.log(`HTTP status: ${ordersRes.status}`);
console.log(`\nTop-level keys: ${Object.keys(ordersData).join(", ")}`);

if (ordersData.orders) {
  const o = ordersData.orders;
  console.log(`\nPagination:`);
  console.log(`  current_page: ${o.current_page}`);
  console.log(`  last_page:    ${o.last_page}`);
  console.log(`  per_page:     ${o.per_page}`);
  console.log(`  total:        ${o.total}`);
  console.log(`  data.length:  ${o.data?.length}`);

  if (o.data?.length > 0) {
    console.log(`\nFirst order keys: ${Object.keys(o.data[0]).join(", ")}`);
    console.log(`\n─── First order (full) ───`);
    console.log(JSON.stringify(o.data[0], null, 2));

    console.log(`\n─── Last order on page 1 ───`);
    const last = o.data.at(-1);
    console.log(`  id:         ${last.id}`);
    console.log(`  status:     ${last.status}`);
    console.log(`  created_at: ${last.created_at}`);
    console.log(`  client:     ${last.client_name}`);

    console.log(`\n─── Status distribution (page 1) ───`);
    const statusCount = {};
    for (const ord of o.data) {
      statusCount[ord.status] = (statusCount[ord.status] || 0) + 1;
    }
    console.log(statusCount);
  }
} else {
  console.log("\nFull response:", JSON.stringify(ordersData, null, 2).slice(0, 2000));
}

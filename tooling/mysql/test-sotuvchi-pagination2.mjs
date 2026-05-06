/**
 * Sotuvchi pagination deep test: find 10-day boundary page
 */
const SOTUVCHI_BASE = "https://apiv3.sotuvchi.com/api";
const email = process.env.SOTUVCHI_EMAIL || "samanhusanov11@gmail.com";
const password = process.env.SOTUVCHI_PASSWORD;

if (!password) { console.error("SOTUVCHI_PASSWORD kerak"); process.exit(1); }

const loginRes = await fetch(`${SOTUVCHI_BASE}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Language": "uz" },
  body: JSON.stringify({ email, password }),
});
const { token } = await loginRes.json();
console.log(`✓ Login OK\n`);

const get = async (page, limit = 50) => {
  const r = await fetch(`${SOTUVCHI_BASE}/getOrders?page=${page}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Language": "uz" },
  });
  return r.json();
};

// Page 1 with limit=50
const p1 = await get(1, 50);
const meta = p1.orders;
console.log(`=== Pagination meta (limit=50) ===`);
console.log(`  total orders : ${meta.total.toLocaleString()}`);
console.log(`  last_page    : ${meta.last_page.toLocaleString()}`);
console.log(`  10-day orders: ~${Math.round(meta.total / (meta.last_page * 50 / 365 / 10))} (rough estimate)`);

// Status distribution on page 1
const statusMap = {};
let newestDate, oldestDate;
for (const o of meta.data) {
  statusMap[o.status] = (statusMap[o.status] || 0) + 1;
  if (!newestDate) newestDate = o.created_at;
  oldestDate = o.created_at;
}
console.log(`\n=== Page 1 (newest 50 orders) ===`);
console.log(`  newest: ${newestDate}`);
console.log(`  oldest: ${oldestDate}`);
console.log(`  statuses:`, statusMap);

// Find the ~10-day boundary page using binary search logic
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
console.log(`\n10 days ago: ${TEN_DAYS_AGO.toISOString()}`);

// Estimate: sample page 5, 20, 50, 100 to see date range
console.log(`\n=== Date sampling across pages ===`);
for (const pg of [1, 5, 20, 50, 100, 200]) {
  if (pg > meta.last_page) break;
  const d = await get(pg, 50);
  const orders = d.orders?.data || [];
  if (!orders.length) continue;
  const first = orders[0];
  const last = orders.at(-1);
  const isWithin10 = new Date(last.created_at) > TEN_DAYS_AGO;
  console.log(`  Page ${String(pg).padStart(3)}: ${first.created_at.slice(0,10)} → ${last.created_at.slice(0,10)}  ${isWithin10 ? '✓ within 10d' : '✗ older than 10d'}`);
  await new Promise(r => setTimeout(r, 500));
}

// Show one full order to see all available fields
console.log(`\n=== Fields available in /getOrders ===`);
console.log(Object.keys(meta.data[0]).join(", "));

console.log(`\n=== sub_status values on page 1 ===`);
const subStatuses = [...new Set(meta.data.map(o => o.sub_status))];
console.log(subStatuses);

console.log(`\n=== Phone field (masked?) ===`);
console.log(`  phone object: ${JSON.stringify(meta.data[0].phone)}`);
console.log(`  client_name:  ${meta.data[0].client_name}`);

/**
 * Show raw Sotuvchi /getOrders response — full detail
 */
const SOTUVCHI_BASE = "https://apiv3.sotuvchi.com/api";

const loginRes = await fetch(`${SOTUVCHI_BASE}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Language": "uz" },
  body: JSON.stringify({ email: "samanhusanov11@gmail.com", password: process.env.SOTUVCHI_PASSWORD }),
});
const { token } = await loginRes.json();

// Fetch 3 orders only — full raw response
const res = await fetch(`${SOTUVCHI_BASE}/getOrders?page=1&limit=3`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Language": "uz" },
});

const data = await res.json();

console.log("=== RAW RESPONSE (3 ta order) ===\n");
console.log(JSON.stringify(data, null, 2));

/**
 * Pagination tartibini aniqlash + filter parametrlarini sinash.
 */

import "dotenv/config";
import axios from "axios";

const BASE = "https://api.100k.uz/api";
const PHONE = "+998996006103";
const PASSWORD = "Samandar-2003";

async function main(): Promise<void> {
  const loginRes = await axios.post(
    `${BASE}/auth/sign-in`,
    { username: PHONE, phone: PHONE, password: PASSWORD },
    { timeout: 15_000 },
  );
  const token = loginRes.data?.data as string;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const meRes = await axios.get(`${BASE}/users/getMe`, { headers, timeout: 15_000 });
  const profileId = String(meRes.data?.data?.id ?? "");

  // Compare first page vs middle page vs last page — see if dates progress
  const pagesToProbe = [1, 2, 5, 10, 100, 500, 5000, 10375];
  for (const page of pagesToProbe) {
    try {
      const res = await axios.get(`${BASE}/users/${profileId}/advertiser-orders`, {
        params: { profile_id: profileId, page, lead_source_grouped: "in_progress" },
        headers,
        timeout: 25_000,
      });
      const data = (res.data?.data ?? []) as Array<Record<string, unknown>>;
      if (data.length === 0) {
        console.log(`page=${page}: empty`);
        continue;
      }
      const created = data.map((o) => String(o.created_at ?? "?"));
      const updated = data.map((o) => String(o.updated_at ?? "?"));
      const ids = data.map((o) => Number(o.id ?? 0));
      console.log(`\npage=${page}:`);
      console.log(`  ids: ${Math.min(...ids)} .. ${Math.max(...ids)} (${ids.length})`);
      console.log(`  created_at: first=${created[0]}, last=${created[created.length - 1]}`);
      console.log(`  updated_at: first=${updated[0]}, last=${updated[updated.length - 1]}`);
      const statuses = new Set(data.map((o) => String(o.status ?? "?")));
      console.log(`  statuses on page: ${[...statuses].join(", ")}`);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`page=${page} ERROR ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Check what query params the endpoint accepts (filter by date / status / sort)
  console.log(`\n=== Probing filter params ===`);
  const probes = [
    { sort: "created_at", direction: "desc" },
    { sort: "updated_at", direction: "desc" },
    { order_by: "created_at" },
    { from: "2026-03-01", to: "2026-03-31" },
    { date_from: "2026-03-01", date_to: "2026-03-31" },
    { from_date: "2026-03-01", to_date: "2026-03-31" },
    { created_from: "2026-03-01", created_to: "2026-03-31" },
    { status: "new" },
    { search: "16076149" },
    { id: "16076149" },
    { customer_phone: "+998507192005" },
  ];
  for (const extraParams of probes) {
    try {
      const res = await axios.get(`${BASE}/users/${profileId}/advertiser-orders`, {
        params: { profile_id: profileId, page: 1, lead_source_grouped: "in_progress", ...extraParams },
        headers,
        timeout: 15_000,
      });
      const data = (res.data?.data ?? []) as Array<Record<string, unknown>>;
      const meta = res.data?.meta ?? {};
      const firstId = data[0]?.id ?? "?";
      const firstCreated = data[0]?.created_at ?? "?";
      console.log(
        `  ${JSON.stringify(extraParams)}: total=${meta.total}, last_page=${meta.last_page}, first id=${firstId}, first created=${firstCreated}`,
      );
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`  ${JSON.stringify(extraParams)} → ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e?.message ?? e);
  process.exit(1);
});

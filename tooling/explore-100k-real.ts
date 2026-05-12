/**
 * Real account (+998996006103) bilan 100k.uz API'ni o'rganish.
 * - login → token
 * - getMe → profileId
 * - har xil endpointlarni sinash
 * - status taqsimoti
 */

import "dotenv/config";
import axios from "axios";

const BASE = "https://api.100k.uz/api";
const PHONE = "+998996006103";
const PASSWORD = "Samandar-2003";

async function main(): Promise<void> {
  // 1) login
  const loginRes = await axios.post(
    `${BASE}/auth/sign-in`,
    { username: PHONE, phone: PHONE, password: PASSWORD },
    { timeout: 15_000 },
  );
  const tokenString = loginRes.data?.data as string;
  console.log(`token (first 30): ${tokenString.slice(0, 30)}...`);

  const headers = {
    Authorization: `Bearer ${tokenString}`,
    Accept: "application/json",
  };

  // 2) getMe
  const meRes = await axios.get(`${BASE}/users/getMe`, { headers, timeout: 15_000 });
  const profileId = String(meRes.data?.data?.id ?? "");
  console.log(`profileId=${profileId}`);
  console.log(`me data keys: ${Object.keys(meRes.data?.data ?? {}).join(", ")}`);
  console.log(`me data sample: ${JSON.stringify(meRes.data?.data).slice(0, 600)}`);

  // 3) advertiser-orders pagination — full distribution
  console.log(`\n=== advertiser-orders (lead_source_grouped=in_progress) ===`);
  const statusDist = new Map<string, number>();
  let totalCollected = 0;
  let lastPage = 1;
  let firstSample: Record<string, unknown> | null = null;
  for (let page = 1; page <= 10; page++) {
    try {
      const res = await axios.get(`${BASE}/users/${profileId}/advertiser-orders`, {
        params: { profile_id: profileId, page, lead_source_grouped: "in_progress" },
        headers,
        timeout: 25_000,
      });
      const data = (res.data?.data ?? []) as Array<Record<string, unknown>>;
      const meta = res.data?.meta ?? {};
      lastPage = Number(meta.last_page ?? page);
      const total = Number(meta.total ?? 0);
      if (page === 1) {
        console.log(`  total=${total}, last_page=${lastPage}`);
        if (data[0]) firstSample = data[0];
      }
      if (!data.length) break;
      for (const o of data) {
        const s = String(o.status ?? "?");
        statusDist.set(s, (statusDist.get(s) ?? 0) + 1);
      }
      totalCollected += data.length;
      console.log(`  page ${page}/${lastPage}: ${data.length}`);
      if (page >= lastPage) break;
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`  page ${page} ERROR ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 300)}`);
      break;
    }
  }
  console.log(`\n  collected=${totalCollected}`);
  console.log(`  status dist:`);
  for (const [s, n] of [...statusDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${s}: ${n}`);
  if (firstSample) {
    console.log(`\n  first row keys: ${Object.keys(firstSample).join(", ")}`);
  }

  // 4) Try /shop/v1/orders/{id} on a known order id (from our DB)
  const testIds = ["16076149", "16076237"];
  console.log(`\n=== /shop/v1/orders/{id} ===`);
  for (const id of testIds) {
    try {
      const res = await axios.get(`${BASE}/shop/v1/orders/${id}`, {
        params: { profile_id: profileId },
        headers,
        timeout: 15_000,
      });
      const d = res.data?.data ?? res.data;
      console.log(`  ${id}: status=${d?.status}, status_label=${d?.status_label}, created_at=${d?.created_at}`);
      console.log(`    full: ${JSON.stringify(d).slice(0, 500)}`);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`  ${id} ERROR ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 5) Try other potentially relevant endpoints
  console.log(`\n=== Probing other endpoints ===`);
  const probes = [
    `/users/${profileId}`,
    `/users/${profileId}/orders`,
    `/users/${profileId}/orders?page=1`,
    `/orders?page=1`,
    `/shop/v1/orders?page=1`,
    `/users/${profileId}/leads`,
    `/users/${profileId}/leads?page=1`,
  ];
  for (const path of probes) {
    try {
      const res = await axios.get(`${BASE}${path}`, { headers, timeout: 15_000 });
      const data = res.data?.data;
      const meta = res.data?.meta ?? {};
      const len = Array.isArray(data) ? data.length : "n/a";
      console.log(`  ${path} → ${res.status}, data.length=${len}, total=${meta.total ?? "?"}`);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`    keys: ${Object.keys(data[0]).slice(0, 12).join(", ")}`);
      }
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`  ${path} → ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 150)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e?.message ?? e);
  process.exit(1);
});

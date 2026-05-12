/**
 * 100k.uz API strukturasini chuqur o'rganish:
 *   1. /advertiser-orders ning DB'dagi haqiqiy orderlarini yoki yo'qmi tekshiradi
 *   2. paginatsiya va status taqsimoti
 *   3. order detail endpoint javob shaklini ko'radi
 */

import "dotenv/config";
import axios from "axios";
import { eq, and, isNotNull } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  crmConnections,
  orders,
  targetWebsites,
  integrations,
} from "../drizzle/schema";
import { decrypt } from "../server/encryption";

const BASE = "https://api.100k.uz/api";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [acc] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.platform, "100k"))
    .limit(1);
  if (!acc) throw new Error("100k account topilmadi");

  const token = decrypt(acc.bearerTokenEncrypted);
  const profileId = acc.platformUserId!;
  console.log(`profileId=${profileId}\n`);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  // 1) Get a few sample external order IDs from our DB
  const ourOrders = await db
    .select({
      orderId: orders.id,
      responseData: orders.responseData,
      crmStatus: orders.crmStatus,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(targetWebsites.appKey, "100k"),
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
      ),
    )
    .limit(5);

  console.log(`=== ${ourOrders.length} sample DB orders ===`);
  const sampleIds: string[] = [];
  for (const o of ourOrders) {
    const r = o.responseData as Record<string, unknown>;
    const data = r?.data as Record<string, unknown> | undefined;
    const externalId = String(data?.order_id ?? data?.id ?? r?.id ?? "?");
    sampleIds.push(externalId);
    console.log(`DB order ${o.orderId} (${o.createdAt.toISOString().slice(0, 10)}) → external ${externalId}`);
  }

  // 2) Try GET /shop/v1/orders/{id} for each sample id — this is the per-order endpoint
  console.log(`\n=== GET /shop/v1/orders/{id} ===`);
  for (const id of sampleIds) {
    try {
      const res = await axios.get(`${BASE}/shop/v1/orders/${id}`, {
        params: { profile_id: profileId },
        headers,
        timeout: 15_000,
      });
      const d = res.data?.data ?? res.data;
      console.log(`  ${id}: status=${d?.status ?? "?"}, status_label=${d?.status_label ?? "?"}, created_at=${d?.created_at ?? "?"}`);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`  ${id}: ERROR ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 3) Walk the full advertiser-orders pagination — collect status distribution
  console.log(`\n=== Full pagination of /advertiser-orders (in_progress) ===`);
  let totalCollected = 0;
  const statusDist = new Map<string, number>();
  const allFetchedIds: string[] = [];
  let lastPage = 1;
  for (let page = 1; page <= 50; page++) {
    try {
      const res = await axios.get(`${BASE}/users/${profileId}/advertiser-orders`, {
        params: {
          profile_id: profileId,
          page,
          lead_source_grouped: "in_progress",
        },
        headers,
        timeout: 20_000,
      });
      const data = (res.data?.data ?? []) as Array<Record<string, unknown>>;
      const meta = res.data?.meta ?? {};
      lastPage = Number(meta.last_page ?? page);
      if (!data.length) break;
      for (const o of data) {
        const s = String(o.status ?? "?");
        statusDist.set(s, (statusDist.get(s) ?? 0) + 1);
        allFetchedIds.push(String(o.id));
      }
      totalCollected += data.length;
      console.log(`  page ${page}/${lastPage}: ${data.length} orders, total=${meta.total}`);
      if (page >= lastPage) break;
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      console.log(`  page ${page}: ERROR ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`);
      break;
    }
  }
  console.log(`\n  TOTAL collected: ${totalCollected}`);
  console.log(`  Status distribution:`);
  for (const [s, n] of [...statusDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s}: ${n}`);
  }

  // 4) Check overlap: how many of our DB external IDs appear in the API list?
  const apiSet = new Set(allFetchedIds);
  const dbSet = new Set(sampleIds);
  const overlap = [...dbSet].filter((id) => apiSet.has(id));
  console.log(`\n  DB sample IDs in API list: ${overlap.length}/${sampleIds.length}`);

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e);
  process.exit(1);
});

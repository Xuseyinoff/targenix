/**
 * 80,164 SENT orderlardan 16,216 tasi CRM Orders'da — qolgan 63,948 qayerda?
 * To'liq taqsimot:
 *   - appKey + templateType + url
 *   - destination kategoriya (telegram / google_sheets / custom URL / affiliate)
 *   - eng ko'p uchragan endpointlar
 *   - per-lead nechta orderi bor (duplicates)
 */

import "dotenv/config";
import { sql, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  orders,
  targetWebsites,
  integrations,
  leads,
} from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // 1) appKey + templateType to'liq taqsimot
  console.log("\n=== SENT orderlar appKey + templateType bo'yicha ===");
  const all = await db
    .select({
      appKey: targetWebsites.appKey,
      templateType: targetWebsites.templateType,
      n: sql<number>`COUNT(*)`,
      withResponseData: sql<number>`SUM(CASE WHEN ${orders.responseData} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(eq(orders.status, "SENT"))
    .groupBy(targetWebsites.appKey, targetWebsites.templateType);
  let grandTotal = 0;
  for (const r of all.sort((a, b) => b.n - a.n)) {
    console.log(
      `  appKey=${(r.appKey ?? "(null)").padEnd(20)} templateType=${(r.templateType ?? "(null)").padEnd(20)} → ${String(r.n).padStart(7)} (responseData: ${r.withResponseData})`,
    );
    grandTotal += Number(r.n);
  }
  console.log(`  GRAND TOTAL: ${grandTotal}`);

  // 2) Top 15 url shu telegram/sheets uchun (qaysi destinatsiya?)
  console.log("\n=== Top 15 destinatsiya URL ===");
  const urls = await db
    .select({
      url: targetWebsites.url,
      name: targetWebsites.name,
      appKey: targetWebsites.appKey,
      templateType: targetWebsites.templateType,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(eq(orders.status, "SENT"))
    .groupBy(targetWebsites.url, targetWebsites.name, targetWebsites.appKey, targetWebsites.templateType)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(15);
  for (const r of urls) {
    console.log(
      `  ${String(r.n).padStart(6)} | appKey=${(r.appKey ?? "-").padEnd(12)} | type=${(r.templateType ?? "-").padEnd(15)} | url=${(r.url ?? "(null)").slice(0, 70)}`,
    );
  }

  // 3) Total leads vs SENT orders — bitta leaddan nechta order chiqadi?
  console.log("\n=== Leads vs SENT orders ===");
  const [leadsCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(leads);
  console.log(`  leads jadvalida: ${leadsCount.n} ta lead`);

  // Has at least one SENT order
  const [leadsWithSent] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${orders.leadId})` })
    .from(orders)
    .where(eq(orders.status, "SENT"));
  console.log(`  Kamida bitta SENT orderga ega leadlar: ${leadsWithSent.n}`);

  // Average orders per lead
  const dups = await db
    .select({
      ordersPerLead: sql<number>`cnt`,
      leadCount: sql<number>`COUNT(*)`,
    })
    .from(sql`(SELECT leadId, COUNT(*) AS cnt FROM orders WHERE status='SENT' GROUP BY leadId) AS t`)
    .groupBy(sql`cnt`)
    .orderBy(sql`cnt DESC`)
    .limit(20);
  console.log("\n  Bitta leadda nechta SENT order (eng ko'p):");
  for (const d of dups) {
    console.log(`    ${d.ordersPerLead} order/lead × ${d.leadCount} ta lead`);
  }

  // 4) FAILED, PENDING orderlar appKey bo'yicha
  console.log("\n=== FAILED + PENDING orderlar appKey bo'yicha ===");
  const failedDist = await db
    .select({
      status: orders.status,
      appKey: targetWebsites.appKey,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(sql`${orders.status} IN ('FAILED', 'PENDING')`)
    .groupBy(orders.status, targetWebsites.appKey);
  for (const r of failedDist) {
    console.log(`  status=${r.status}  appKey=${r.appKey ?? "(null)"} → ${r.n}`);
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

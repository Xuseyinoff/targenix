/**
 * /admin/crm/orders da ko'rsatilmayotgan orderlarni topish:
 *   - orders status=SENT bo'lib, lekin filter sababli chiqib qolayotganlar
 *   - appKey, responseData, templateType bo'yicha taqsimot
 */

import "dotenv/config";
import { sql, eq, and, isNotNull, isNull, or } from "drizzle-orm";
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

  // 1) total SENT orders (any platform)
  const [totalSent] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .where(eq(orders.status, "SENT"));
  console.log(`Total orders.status='SENT': ${totalSent.n}`);

  // 2) orders.status distribution
  const statusDist = await db
    .select({ status: orders.status, n: sql<number>`COUNT(*)` })
    .from(orders)
    .groupBy(orders.status);
  console.log("\norders.status distribution:");
  for (const r of statusDist) console.log(`  ${r.status}: ${r.n}`);

  // 3) SENT orders broken down by appKey (this is exactly listOrders' filter source)
  const appKeyDist = await db
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
  console.log("\nSENT orders by (appKey, templateType):");
  for (const r of appKeyDist) {
    console.log(`  appKey=${r.appKey ?? "(null)"}  templateType=${r.templateType ?? "(null)"}: ${r.n}  (with responseData: ${r.withResponseData})`);
  }

  // 4) The listOrders filter would return:
  const [visible] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        or(eq(targetWebsites.appKey, "sotuvchi"), eq(targetWebsites.appKey, "100k")),
      ),
    );
  console.log(`\n/admin/crm/orders bu hozir ko'rsatadi: ${visible.n} ta`);

  // 5) "Lost" orders — SENT but excluded by the listOrders filter
  const [lost] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        sql`NOT (
          ${orders.responseData} IS NOT NULL
          AND ${targetWebsites.appKey} IN ('sotuvchi', '100k')
        )`,
      ),
    );
  console.log(`SENT orderlar listOrders filteridan tushib qolayotganlar: ${lost.n} ta`);

  // 6) Sample of those "lost" orders — what's wrong with each?
  const samples = await db
    .select({
      orderId: orders.id,
      status: orders.status,
      hasResponseData: sql<number>`(${orders.responseData} IS NOT NULL)`,
      appKey: targetWebsites.appKey,
      templateType: targetWebsites.templateType,
      url: targetWebsites.url,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        sql`NOT (
          ${orders.responseData} IS NOT NULL
          AND ${targetWebsites.appKey} IN ('sotuvchi', '100k')
        )`,
      ),
    )
    .limit(10);
  console.log("\nNamuna (10 ta yashirin SENT order):");
  for (const r of samples) {
    console.log(
      `  orderId=${r.orderId}, hasResponseData=${r.hasResponseData}, appKey=${r.appKey ?? "(null)"}, templateType=${r.templateType ?? "(null)"}, url=${r.url?.slice(0, 60) ?? "(null)"}`,
    );
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

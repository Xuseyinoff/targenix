/**
 * 100k.uz CRM sync diagnostikasi.
 * Sync nima uchun ishlamasligini aniqlaydi: account, target websites, orders.
 *
 *   pnpm exec tsx tooling/inspect-100k-state.ts
 */

import "dotenv/config";
import { sql, eq, isNotNull, and } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  crmConnections,
  orders,
  targetWebsites,
  integrations,
} from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const accs = await db
    .select({
      id: crmConnections.id,
      platform: crmConnections.platform,
      displayName: crmConnections.displayName,
      phone: crmConnections.phone,
      platformUserId: crmConnections.platformUserId,
      status: crmConnections.status,
      lastLoginAt: crmConnections.lastLoginAt,
    })
    .from(crmConnections)
    .where(eq(crmConnections.platform, "100k"));
  console.log("\n=== crm_connections (platform=100k) ===");
  console.log(accs.length === 0 ? "(BO'SH — 100k akkaunt yo'q!)" : JSON.stringify(accs, null, 2));

  const tws = await db
    .select({ appKey: targetWebsites.appKey, n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(sql`${targetWebsites.appKey} LIKE '%100%' OR ${targetWebsites.appKey} = 'sotuvchi'`)
    .groupBy(targetWebsites.appKey);
  console.log("\n=== target_websites GROUP BY appKey ===");
  console.log(tws);

  const ords = await db
    .select({
      orderId: orders.id,
      crmStatus: orders.crmStatus,
      isFinal: orders.isFinal,
      crmSyncedAt: orders.crmSyncedAt,
      appKey: targetWebsites.appKey,
      responseData: orders.responseData,
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
    .limit(3);
  console.log(`\n=== sample 100k orders (count<=3, appKey='100k') === ${ords.length}`);
  for (const o of ords) {
    console.log({
      orderId: o.orderId,
      crmStatus: o.crmStatus,
      isFinal: o.isFinal,
      crmSyncedAt: o.crmSyncedAt,
      responseDataSnippet: JSON.stringify(o.responseData).slice(0, 300),
    });
  }

  const totalCount = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(targetWebsites.appKey, "100k"),
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
      ),
    );
  console.log(`\n=== TOTAL 100k orders (SENT, has responseData): ${totalCount[0]?.n ?? 0} ===`);

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e);
  process.exit(1);
});

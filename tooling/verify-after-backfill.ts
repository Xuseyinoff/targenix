/**
 * Backfill'dan keyin: yangi listOrders query bilan jami nechta ko'rinadi
 */
import "dotenv/config";
import { sql, eq, and, isNotNull, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  orders,
  integrations,
  integrationDestinations,
  targetWebsites,
} from "../drizzle/schema";

const AFFILIATE_APP_KEYS = ["sotuvchi", "100k", "alijahon", "inbaza", "mgoods"];

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const twJoinExpr = sql`${targetWebsites.id} = COALESCE(${integrationDestinations.targetWebsiteId}, ${integrations.targetWebsiteId})`;

  const [r] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .leftJoin(integrations, eq(orders.integrationId, integrations.id))
    .leftJoin(integrationDestinations, eq(orders.destinationId, integrationDestinations.id))
    .innerJoin(targetWebsites, twJoinExpr)
    .where(
      and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        inArray(targetWebsites.appKey, AFFILIATE_APP_KEYS),
      ),
    );
  console.log(`Yangi listOrders query (COALESCE both paths): ${r.n} ta order ko'rinadi`);

  // Per-platform breakdown
  const dist = await db
    .select({
      appKey: targetWebsites.appKey,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .leftJoin(integrations, eq(orders.integrationId, integrations.id))
    .leftJoin(integrationDestinations, eq(orders.destinationId, integrationDestinations.id))
    .innerJoin(targetWebsites, twJoinExpr)
    .where(
      and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        inArray(targetWebsites.appKey, AFFILIATE_APP_KEYS),
      ),
    )
    .groupBy(targetWebsites.appKey);
  console.log("\nPer platform:");
  for (const x of dist.sort((a, b) => b.n - a.n)) {
    console.log(`  ${x.appKey}: ${x.n}`);
  }

  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

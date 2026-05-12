/**
 * Sync ishlab turganda 100k orderlardagi crmStatus o'zgarganini tekshirish.
 */

import "dotenv/config";
import { sql, eq, and } from "drizzle-orm";
import { getDb } from "../server/db";
import { orders, targetWebsites, integrations } from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const dist = await db
    .select({
      crmStatus: orders.crmStatus,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(and(eq(targetWebsites.appKey, "100k"), eq(orders.status, "SENT")))
    .groupBy(orders.crmStatus);

  console.log("100k order crmStatus distribution:");
  for (const r of dist) {
    console.log(`  ${r.crmStatus ?? "(null)"}: ${r.n}`);
  }
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

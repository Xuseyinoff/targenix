/**
 * 62,517 ta SENT order targetWebsiteId NULL — `integration_destinations` orqali keladi.
 */
import "dotenv/config";
import { sql, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  orders,
  integrations,
  integrationDestinations,
  targetWebsites,
} from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // 1) destinationId borligi
  console.log("=== SENT orderlar destinationId bo'yicha ===");
  const [withDest] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .where(sql`${orders.status} = 'SENT' AND ${orders.destinationId} IS NOT NULL`);
  const [noDest] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .where(sql`${orders.status} = 'SENT' AND ${orders.destinationId} IS NULL`);
  console.log(`  destinationId BOR: ${withDest.n}`);
  console.log(`  destinationId NULL: ${noDest.n}`);

  // 2) orders → integration_destinations → targetWebsites
  console.log("\n=== orders → integration_destinations → targetWebsites ===");
  const dist = await db
    .select({
      appKey: targetWebsites.appKey,
      templateType: targetWebsites.templateType,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .innerJoin(integrationDestinations, eq(orders.destinationId, integrationDestinations.id))
    .innerJoin(targetWebsites, eq(integrationDestinations.targetWebsiteId, targetWebsites.id))
    .where(eq(orders.status, "SENT"))
    .groupBy(targetWebsites.appKey, targetWebsites.templateType);
  let total = 0;
  for (const r of dist.sort((a, b) => b.n - a.n)) {
    console.log(
      `  appKey=${(r.appKey ?? "(null)").padEnd(20)} templateType=${(r.templateType ?? "(null)").padEnd(20)} → ${r.n}`,
    );
    total += Number(r.n);
  }
  console.log(`  TOTAL via integration_destinations: ${total}`);

  // 3) Birlashtirilgan: ikkala yo'l bilan jami nechta?
  console.log("\n=== Yakuniy — har xil yo'llar bilan ===");
  const [a] = await db.select({ n: sql<number>`COUNT(*)` }).from(orders).where(eq(orders.status, "SENT"));
  console.log(`  Jami SENT: ${a.n}`);

  // via integrations.targetWebsiteId (eski yo'l)
  const [b] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(eq(orders.status, "SENT"));
  console.log(`  integrations.targetWebsiteId orqali: ${b.n}`);

  // via integration_destinations (yangi yo'l - fan-out)
  console.log(`  integration_destinations orqali: ${total}`);

  // Birlashtirib — yagona orderlar (UNION DISTINCT)
  const [c] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${orders.id})` })
    .from(orders)
    .leftJoin(integrations, eq(orders.integrationId, integrations.id))
    .leftJoin(integrationDestinations, eq(orders.destinationId, integrationDestinations.id))
    .where(
      sql`${orders.status} = 'SENT' AND (
        ${integrations.targetWebsiteId} IS NOT NULL
        OR ${integrationDestinations.id} IS NOT NULL
      )`,
    );
  console.log(`  Ikkala yo'lda birgalikda (unique): ${c.n}`);

  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

/**
 * destinationId=0 va integrations.targetWebsiteId=NULL — 38,052 ta yashirin order:
 *   - Bu integrationlar fan-out-ga migrated bo'lgan eski orderlarmi?
 *   - integration_destinations ichida shu integration uchun nima bor?
 */
import "dotenv/config";
import { sql, eq, and, isNull } from "drizzle-orm";
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

  // Sample 5 "lost" orderlar (destId=0, int.twId=NULL)
  const samples = await db
    .select({
      orderId: orders.id,
      integrationId: orders.integrationId,
      integrationName: integrations.name,
      intTargetWebsiteId: integrations.targetWebsiteId,
      destinationId: orders.destinationId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        eq(orders.destinationId, 0),
        isNull(integrations.targetWebsiteId),
      ),
    )
    .orderBy(sql`${orders.id} DESC`)
    .limit(5);

  console.log("=== 5 ta yashirin order namuna ===");
  for (const s of samples) {
    console.log(`\norderId=${s.orderId}, integrationId=${s.integrationId}, name=${s.integrationName}, intTargetWebsiteId=${s.intTargetWebsiteId ?? "NULL"}`);

    // Bu integration uchun nechta destinatsiya bor (fan-out)
    const dests = await db
      .select({
        id: integrationDestinations.id,
        targetWebsiteId: integrationDestinations.targetWebsiteId,
        appKey: targetWebsites.appKey,
        twName: targetWebsites.name,
      })
      .from(integrationDestinations)
      .innerJoin(targetWebsites, eq(integrationDestinations.targetWebsiteId, targetWebsites.id))
      .where(eq(integrationDestinations.integrationId, s.integrationId!));
    console.log(`  Bu integration uchun ${dests.length} ta integration_destinations qator:`);
    for (const d of dests) {
      console.log(`    id=${d.id}, targetWebsiteId=${d.targetWebsiteId}, appKey=${d.appKey}, name=${d.twName}`);
    }
  }

  // Statistika — bu yashirin orderlarning integrationlari nechtasi haqiqatan ham
  // hozir integration_destinations ga ega?
  console.log("\n=== Statistika ===");
  const [withFanOut] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${orders.id})` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(integrationDestinations, eq(integrationDestinations.integrationId, integrations.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        eq(orders.destinationId, 0),
        isNull(integrations.targetWebsiteId),
      ),
    );
  console.log(`  Yashirin orderlardan integrationi fan-out destinatsiyaga ega bo'lganlari: ${withFanOut.n}`);

  // 38,052 - withFanOut = haqiqatan o'chirilgan integrationlar (orphan)

  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

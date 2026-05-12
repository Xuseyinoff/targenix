/**
 * destinationId = 0 sentinel qiymat tekshirish (legacy single-destination yo'l)
 */
import "dotenv/config";
import { sql, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { orders } from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const dist = await db
    .select({
      destBucket: sql<string>`CASE WHEN ${orders.destinationId} = 0 THEN '0 (legacy sentinel)' WHEN ${orders.destinationId} > 0 THEN '>0 (fan-out)' ELSE 'NULL' END`,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .where(eq(orders.status, "SENT"))
    .groupBy(sql`CASE WHEN ${orders.destinationId} = 0 THEN '0 (legacy sentinel)' WHEN ${orders.destinationId} > 0 THEN '>0 (fan-out)' ELSE 'NULL' END`);
  console.log("destinationId taqsimoti (SENT orderlar):");
  for (const r of dist) console.log(`  ${r.destBucket}: ${r.n}`);
  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

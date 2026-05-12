/**
 * Yangi orderlar destinationId=0 bo'lyaptimi yoki yo'qmi (root cause tekshirish).
 * Agar MULTI_DEST_ALL=true bo'lsa, hammasi destinationId>0 bo'lishi kerak.
 */
import "dotenv/config";
import { sql, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { orders } from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Last 30 / 7 / 1 days
  const buckets = [
    { label: "Oxirgi 1 kun", days: 1 },
    { label: "Oxirgi 7 kun", days: 7 },
    { label: "Oxirgi 30 kun", days: 30 },
  ];
  for (const b of buckets) {
    const since = new Date(Date.now() - b.days * 24 * 60 * 60 * 1000);
    const r = await db
      .select({
        destBucket: sql<string>`CASE WHEN ${orders.destinationId} = 0 THEN 'destId=0 (legacy)' ELSE 'destId>0 (yangi)' END`,
        n: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(sql`${orders.status} = 'SENT' AND ${orders.createdAt} >= ${since}`)
      .groupBy(sql`CASE WHEN ${orders.destinationId} = 0 THEN 'destId=0 (legacy)' ELSE 'destId>0 (yangi)' END`);
    console.log(`\n${b.label} (>= ${since.toISOString().slice(0, 10)}):`);
    for (const x of r) console.log(`  ${x.destBucket}: ${x.n}`);
  }
  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

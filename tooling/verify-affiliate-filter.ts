/**
 * AFFILIATE_APP_KEYS bilan yangi filter qanchani ko'rsatadi
 */
import "dotenv/config";
import { sql, eq, and, isNotNull, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import { orders, targetWebsites, integrations } from "../drizzle/schema";

const AFFILIATE_APP_KEYS = ["sotuvchi", "100k", "alijahon", "inbaza", "mgoods"];

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [r] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        inArray(targetWebsites.appKey, AFFILIATE_APP_KEYS),
      ),
    );
  console.log(`Yangi filter natijasi: ${r.n} ta order ko'rinadi`);
  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

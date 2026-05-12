/**
 * 80,164 - 16,216 = 63,948 ta SENT order qayerda?
 * integrationId / targetWebsiteId bog'lanishini tekshirish.
 */
import "dotenv/config";
import { sql, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  orders,
  integrations,
  targetWebsites,
} from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // 1) Barcha SENT orderlar — integrationId borligi
  console.log("=== SENT orderlar integrationId bo'yicha ===");
  const [withInt] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .where(sql`${orders.status} = 'SENT' AND ${orders.integrationId} IS NOT NULL`);
  const [noInt] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .where(sql`${orders.status} = 'SENT' AND ${orders.integrationId} IS NULL`);
  console.log(`  integrationId BOR: ${withInt.n}`);
  console.log(`  integrationId NULL: ${noInt.n}`);

  // 2) Integrations bilan join — targetWebsiteId qanaqa?
  console.log("\n=== integrations.targetWebsiteId bo'yicha ===");
  const intDist = await db
    .select({
      hasTw: sql<number>`(${integrations.targetWebsiteId} IS NOT NULL)`,
      type: integrations.type,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(eq(orders.status, "SENT"))
    .groupBy(sql`(${integrations.targetWebsiteId} IS NOT NULL)`, integrations.type);
  for (const r of intDist) {
    console.log(`  integration.type=${r.type ?? "(null)"} targetWebsiteId=${r.hasTw ? "BOR" : "NULL"} → ${r.n}`);
  }

  // 3) Integrations type distribution
  console.log("\n=== Integrations.type bo'yicha SENT orderlar ===");
  const types = await db
    .select({ type: integrations.type, n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(eq(orders.status, "SENT"))
    .groupBy(integrations.type);
  for (const r of types.sort((a, b) => b.n - a.n)) {
    console.log(`  type=${r.type ?? "(null)"}: ${r.n}`);
  }

  // 4) Eski schema field-lar: orders.affiliate*?
  console.log("\n=== Orphan SENT orderlar (integrations bo'lmagan) qanaqa? ===");
  const [orphan] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .leftJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(sql`${orders.status} = 'SENT' AND ${integrations.id} IS NULL`);
  console.log(`  integrations'siz SENT order: ${orphan.n}`);

  // 5) Sample orphan rows — qanday ko'rinishda?
  const samples = await db
    .select({
      id: orders.id,
      leadId: orders.leadId,
      integrationId: orders.integrationId,
      hasResponseData: sql<number>`(${orders.responseData} IS NOT NULL)`,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .leftJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(sql`${orders.status} = 'SENT' AND ${integrations.id} IS NULL`)
    .orderBy(sql`${orders.id} DESC`)
    .limit(10);
  console.log(`\n  Eng yangi orphan namuna:`);
  for (const s of samples) {
    console.log(
      `    id=${s.id}, leadId=${s.leadId ?? "-"}, integrationId=${s.integrationId ?? "(null)"}, hasResponseData=${s.hasResponseData}, createdAt=${s.createdAt.toISOString().slice(0, 10)}`,
    );
  }

  // 6) Maybe integrations table has rows but targetWebsiteId is NULL
  console.log("\n=== integrations qatorlari nima qiladi? ===");
  const [intsAll] = await db.select({ n: sql<number>`COUNT(*)` }).from(integrations);
  const [intsNoTw] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(integrations)
    .where(isNull(integrations.targetWebsiteId));
  console.log(`  Jami integrations: ${intsAll.n}`);
  console.log(`  Integrations.targetWebsiteId NULL: ${intsNoTw.n}`);

  // 7) Orders.affiliateTemplateId column borligini ham tekshiramiz (eski schema)
  console.log("\n=== orders ustunlari ===");
  const [oneOrder] = await db.select().from(orders).limit(1);
  console.log("  ustun nomlari:", Object.keys(oneOrder ?? {}).join(", "));

  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

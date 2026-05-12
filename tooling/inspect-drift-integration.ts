/**
 * Deep inspect of int#600056 — the only LEAD_ROUTING integration with no
 * destination on either the legacy column or the new join table.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";
import { integrations, integrationDestinations, orders, leads } from "../drizzle/schema";

const ID = 600056;

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [row] = await db.select().from(integrations).where(eq(integrations.id, ID)).limit(1);
  if (!row) {
    console.log(`int#${ID} not found.`);
    process.exit(0);
  }
  console.log("INTEGRATION ROW:");
  console.log(JSON.stringify(row, null, 2));

  console.log("\nintegration_destinations rows (any):");
  const dests = await db.select().from(integrationDestinations).where(eq(integrationDestinations.integrationId, ID));
  console.log(JSON.stringify(dests, null, 2));

  console.log("\nOrder history (all-time count):");
  const [total] = await db.select({ n: sql<number>`COUNT(*)` }).from(orders).where(eq(orders.integrationId, ID));
  console.log(`  total orders: ${total?.n ?? 0}`);

  console.log("\nMost recent 5 orders:");
  const recent = await db
    .select({
      id: orders.id,
      leadId: orders.leadId,
      destinationId: orders.destinationId,
      status: orders.status,
      attempts: orders.attempts,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.integrationId, ID))
    .orderBy(sql`${orders.createdAt} DESC`)
    .limit(5);
  for (const r of recent) {
    console.log(`  order#${r.id} lead=${r.leadId} dest=${r.destinationId} status=${r.status} attempts=${r.attempts} created=${r.createdAt}`);
  }

  console.log("\nLead history matching this integration's page/form:");
  const [leadCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(leads)
    .where(sql`${leads.pageId} = ${row.pageId ?? ""} AND ${leads.formId} = ${row.formId ?? ""}`);
  console.log(`  matching leads (by pageId+formId): ${leadCount?.n ?? 0}`);

  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });

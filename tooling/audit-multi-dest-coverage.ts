/**
 * Verify the integration_destinations join table covers every active
 * LEAD_ROUTING integration. If any integration has rows in legacy
 * `integrations.targetWebsiteId` but ZERO rows in integration_destinations,
 * removing the legacy fall-through in leadService.ts would lose deliveries
 * for that integration.
 */
import "dotenv/config";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";
import { integrations, integrationDestinations, users } from "../drizzle/schema";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("=".repeat(70));
  console.log("MULTI-DESTINATION COVERAGE AUDIT");
  console.log("=".repeat(70));

  // 1. Total active LEAD_ROUTING integrations
  const [tot] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(integrations)
    .where(and(eq(integrations.type, "LEAD_ROUTING"), eq(integrations.isActive, true)));
  console.log(`\n1. Active LEAD_ROUTING integrations: ${tot?.n ?? 0}`);

  // 2. Integrations with at least one row in integration_destinations
  const [withRows] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${integrationDestinations.integrationId})` })
    .from(integrationDestinations)
    .innerJoin(integrations, eq(integrations.id, integrationDestinations.integrationId))
    .where(eq(integrations.isActive, true));
  console.log(`2. With integration_destinations rows : ${withRows?.n ?? 0}`);

  // 3. Integrations with legacy targetWebsiteId set
  const [withLegacy] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(integrations)
    .where(
      and(
        eq(integrations.type, "LEAD_ROUTING"),
        eq(integrations.isActive, true),
        isNotNull(integrations.targetWebsiteId),
      ),
    );
  console.log(`3. With legacy targetWebsiteId column : ${withLegacy?.n ?? 0}`);

  // 4. THE CRITICAL CHECK — integrations that have legacy column but NOT in new table.
  // If this is > 0, removing the fall-through silently drops their deliveries.
  const driftRows = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      name: integrations.name,
      targetWebsiteId: integrations.targetWebsiteId,
      userEmail: users.email,
    })
    .from(integrations)
    .leftJoin(users, eq(users.id, integrations.userId))
    .where(
      and(
        eq(integrations.type, "LEAD_ROUTING"),
        eq(integrations.isActive, true),
        sql`NOT EXISTS (SELECT 1 FROM ${integrationDestinations} WHERE ${integrationDestinations.integrationId} = ${integrations.id})`,
      ),
    );
  console.log(`\n4. DRIFT (active LEAD_ROUTING, no row in integration_destinations): ${driftRows.length}`);
  if (driftRows.length > 0) {
    console.log("   ⚠ Removing the legacy fall-through would lose deliveries for:");
    for (const r of driftRows.slice(0, 50)) {
      console.log(
        `      int#${r.id} u#${r.userId} (${r.userEmail ?? "?"}) twId=${r.targetWebsiteId ?? "—"} "${r.name}"`,
      );
    }
    if (driftRows.length > 50) console.log(`      ... and ${driftRows.length - 50} more`);
  } else {
    console.log("   ✅ Zero drift — every active integration has integration_destinations rows.");
  }

  // 5. Inactive integrations same check (informational only)
  const [inactiveDrift] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(integrations)
    .where(
      and(
        eq(integrations.type, "LEAD_ROUTING"),
        eq(integrations.isActive, false),
        sql`NOT EXISTS (SELECT 1 FROM ${integrationDestinations} WHERE ${integrationDestinations.integrationId} = ${integrations.id})`,
      ),
    );
  console.log(`\n5. Inactive drift (informational): ${inactiveDrift?.n ?? 0}`);

  // 6. Coverage percentage
  const active = Number(tot?.n ?? 0);
  const covered = Number(withRows?.n ?? 0);
  const pct = active > 0 ? ((covered / active) * 100).toFixed(2) : "n/a";
  console.log(`\n6. Coverage: ${covered}/${active} = ${pct}%`);

  if (driftRows.length === 0) {
    console.log("\n✅ SAFE to remove the legacy fall-through in leadService.ts:1168-1184.");
  } else {
    console.log(`\n⚠ NOT SAFE yet — backfill the ${driftRows.length} drifted integration(s) first.`);
    console.log("   Backfill: tooling/mysql/backfill-integration-destinations.mjs");
  }

  await closeDb();
}
main().catch((e) => {
  console.error("AUDIT FAILED:", e);
  process.exit(1);
});

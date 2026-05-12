/**
 * Real-usage audit for the two "deprecated" adapters:
 *   - affiliate          → integrations.type = 'AFFILIATE'
 *   - legacy-template    → target_websites where appKey set but templateId IS NULL
 *
 * For each adapter, the script reports:
 *   • how many rows still exist
 *   • how many are active
 *   • when they were last used (last successful order)
 *   • which users own them (id, name, email)
 *
 * Routing logic is mirrored from server/integrations/resolveAdapterKey.ts so the
 * counts match what dispatch.ts would actually pick.
 */

import "dotenv/config";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";
import {
  integrations,
  orders,
  targetWebsites,
  users,
} from "../drizzle/schema";

// Mirror of resolveAdapterKey.ts — keep in sync.
const HTTP_API_KEY_APP_KEYS = [
  "eskiz-sms",
  "playmobile-sms",
  "openai",
  "crm-generic",
  "webhook-json",
  "bitrix24",
  "amocrm",
];
const HTTP_OAUTH2_APP_KEYS = ["hubspot", "kommo", "pipedrive"];
const FIRST_PARTY_APP_KEYS = [
  "telegram",
  "google-sheets",
  "google_sheets",
  "plain-url",
  ...HTTP_API_KEY_APP_KEYS,
  ...HTTP_OAUTH2_APP_KEYS,
];

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("================================================================");
  console.log("  DEPRECATED ADAPTER USAGE AUDIT");
  console.log("  (local DB:", process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@"), ")");
  console.log("================================================================\n");

  // ─── 1. AFFILIATE adapter ────────────────────────────────────────────────
  console.log("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("┃  [1] AFFILIATE adapter — integrations.type = 'AFFILIATE'");
  console.log("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const affRows = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      name: integrations.name,
      isActive: integrations.isActive,
      createdAt: integrations.createdAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(integrations)
    .leftJoin(users, eq(users.id, integrations.userId))
    .where(eq(integrations.type, "AFFILIATE"));

  console.log(`  Total AFFILIATE integrations: ${affRows.length}`);
  console.log(`  Currently active            : ${affRows.filter((r) => r.isActive).length}`);
  if (affRows.length > 0) {
    console.log("\n  Owners (each row = one AFFILIATE integration):");
    for (const r of affRows) {
      console.log(
        `    int#${String(r.id).padEnd(5)} user#${String(r.userId).padEnd(4)} ${
          r.isActive ? "ACTIVE  " : "inactive"
        } ${(r.userEmail ?? r.userName ?? "(no profile)").padEnd(30)} "${r.name}"`,
      );
    }

    const ids = affRows.map((r) => r.id);
    const recent = await db
      .select({
        integrationId: orders.integrationId,
        last: sql<Date>`MAX(${orders.createdAt})`,
        sentN: sql<number>`SUM(CASE WHEN ${orders.status} = 'SENT' THEN 1 ELSE 0 END)`,
        totalN: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(inArray(orders.integrationId, ids))
      .groupBy(orders.integrationId);
    if (recent.length > 0) {
      console.log("\n  Order activity per AFFILIATE integration:");
      for (const r of recent) {
        console.log(
          `    int#${String(r.integrationId).padEnd(5)} last=${r.last?.toISOString?.() ?? r.last} sent=${r.sentN}/${r.totalN}`,
        );
      }
    } else {
      console.log("\n  ✅ No `orders` rows reference any AFFILIATE integration → dead path.");
    }
  } else {
    console.log("  ✅ Zero rows — the `affiliate` adapter is unreachable via integrations.");
  }

  // ─── 2. LEGACY-TEMPLATE adapter ──────────────────────────────────────────
  // resolveAdapterKey returns "legacy-template" when appKey is set AND
  // templateId IS NULL, AND appKey is not one of the first-party keys handled
  // by dedicated routes above. Practically: appKey ∈ {sotuvchi, 100k, albato,
  // custom, …} and no DB template row.
  console.log("\n\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("┃  [2] LEGACY-TEMPLATE adapter");
  console.log("┃      target_websites where templateId IS NULL");
  console.log("┃      AND appKey is non-first-party (sotuvchi, 100k, albato, custom…)");
  console.log("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Group by appKey (informational)
  const byKey = await db
    .select({
      appKey: targetWebsites.appKey,
      templateType: targetWebsites.templateType,
      n: sql<number>`COUNT(*)`,
    })
    .from(targetWebsites)
    .where(
      and(
        isNull(targetWebsites.templateId),
        notInArray(targetWebsites.appKey, FIRST_PARTY_APP_KEYS),
        sql`${targetWebsites.appKey} <> 'unknown'`,
        sql`${targetWebsites.appKey} <> ''`,
      ),
    )
    .groupBy(targetWebsites.appKey, targetWebsites.templateType)
    .orderBy(desc(sql`COUNT(*)`));

  console.log("  Distribution by appKey × templateType:");
  let totalLegacy = 0;
  for (const r of byKey) {
    totalLegacy += Number(r.n);
    console.log(
      `    appKey="${(r.appKey ?? "(null)").padEnd(15)}" templateType="${(r.templateType ?? "(null)").padEnd(15)}" → ${r.n}`,
    );
  }
  console.log(`\n  Total rows routed to legacy-template adapter: ${totalLegacy}`);

  if (totalLegacy > 0) {
    // List every row + its owner
    const legacyRows = await db
      .select({
        id: targetWebsites.id,
        userId: targetWebsites.userId,
        name: targetWebsites.name,
        appKey: targetWebsites.appKey,
        templateType: targetWebsites.templateType,
        url: targetWebsites.url,
        createdAt: targetWebsites.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(targetWebsites)
      .leftJoin(users, eq(users.id, targetWebsites.userId))
      .where(
        and(
          isNull(targetWebsites.templateId),
          notInArray(targetWebsites.appKey, FIRST_PARTY_APP_KEYS),
          sql`${targetWebsites.appKey} <> 'unknown'`,
          sql`${targetWebsites.appKey} <> ''`,
        ),
      )
      .orderBy(desc(targetWebsites.createdAt));

    console.log("\n  Each target_website that hits legacy-template:");
    for (const r of legacyRows) {
      console.log(
        `    tw#${String(r.id).padEnd(5)} user#${String(r.userId).padEnd(4)} appKey=${(r.appKey ?? "").padEnd(10)} tpl=${(r.templateType ?? "").padEnd(10)} ${(r.userEmail ?? r.userName ?? "(no profile)").padEnd(30)} "${r.name}"  url=${r.url ?? "—"}`,
      );
    }

    // Real delivery activity — orders.targetWebsiteId may not exist; orders is
    // linked to integration, so we look at the integration_destinations join.
    const twIds = legacyRows.map((r) => r.id);
    if (twIds.length > 0) {
      const activity = await db
        .select({
          twId: targetWebsites.id,
          lastSentAt: sql<Date>`MAX(CASE WHEN ${orders.status} = 'SENT' THEN ${orders.createdAt} END)`,
          lastAttemptAt: sql<Date>`MAX(${orders.createdAt})`,
          sentN: sql<number>`SUM(CASE WHEN ${orders.status} = 'SENT' THEN 1 ELSE 0 END)`,
          totalN: sql<number>`COUNT(${orders.id})`,
        })
        .from(targetWebsites)
        .leftJoin(orders, eq(orders.targetWebsiteId, targetWebsites.id))
        .where(inArray(targetWebsites.id, twIds))
        .groupBy(targetWebsites.id);

      console.log("\n  Delivery activity per legacy-template target_website:");
      for (const a of activity) {
        const last = a.lastSentAt
          ? new Date(a.lastSentAt as unknown as string).toISOString()
          : "(never sent)";
        console.log(
          `    tw#${String(a.twId).padEnd(5)} sent=${a.sentN}/${a.totalN}  lastSent=${last}`,
        );
      }
    }
  } else {
    console.log("  ✅ No target_websites rows route through legacy-template.");
  }

  // ─── 3. SUMMARY ──────────────────────────────────────────────────────────
  console.log("\n\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("┃  [3] SUMMARY (for comparison)");
  console.log("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // dynamic-template = templateId NOT NULL + appKey non-first-party
  const [dyn] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(
      and(
        isNotNull(targetWebsites.templateId),
        notInArray(targetWebsites.appKey, FIRST_PARTY_APP_KEYS),
      ),
    );
  const [tg] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(eq(targetWebsites.appKey, "telegram"));
  const [gs] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(
      or(
        eq(targetWebsites.appKey, "google-sheets"),
        eq(targetWebsites.appKey, "google_sheets"),
      ),
    );
  const [pu] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(eq(targetWebsites.appKey, "plain-url"));
  const [api] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(inArray(targetWebsites.appKey, HTTP_API_KEY_APP_KEYS));
  const [oauth] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(inArray(targetWebsites.appKey, HTTP_OAUTH2_APP_KEYS));
  const [twTotal] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites);

  console.log("  target_websites distribution by adapter route:");
  console.log(`    dynamic-template (modern admin templates) : ${dyn?.n ?? 0}`);
  console.log(`    legacy-template  (DEPRECATED)             : ${totalLegacy}`);
  console.log(`    telegram         (dedicated)              : ${tg?.n ?? 0}`);
  console.log(`    google-sheets    (dedicated)              : ${gs?.n ?? 0}`);
  console.log(`    plain-url        (custom http)            : ${pu?.n ?? 0}`);
  console.log(`    http-api-key     (eskiz/playmobile/…)     : ${api?.n ?? 0}`);
  console.log(`    http-oauth2      (hubspot/kommo/…)        : ${oauth?.n ?? 0}`);
  console.log(`    ──────────────────────────────────────────`);
  console.log(`    TOTAL target_websites rows                : ${twTotal?.n ?? 0}`);
  console.log(`    Active AFFILIATE integrations             : ${affRows.filter((r) => r.isActive).length} (deprecated path)`);

  await closeDb();
}

main().catch((e) => {
  console.error("AUDIT FAILED:", e);
  process.exit(1);
});

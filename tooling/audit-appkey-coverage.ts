/**
 * Sprint 4 / Item 4.3 prerequisite — check whether `target_websites.appKey`
 * is populated everywhere `templateType` is the only routing signal. If any
 * row still has appKey NULL or 'unknown' AND has a templateType set, the
 * templateType-first branch in resolveAdapterKey is still load-bearing and
 * we must NOT remove it yet.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { targetWebsites } from "../drizzle/schema";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("=== target_websites appKey coverage audit ===\n");

  const [byAppKey] = await Promise.all([
    db
      .select({
        appKey: targetWebsites.appKey,
        n: sql<number>`COUNT(*)`,
      })
      .from(targetWebsites)
      .groupBy(targetWebsites.appKey),
  ]);

  console.log("appKey distribution:");
  let total = 0;
  let problematic = 0;
  for (const r of byAppKey.sort((a, b) => Number(b.n) - Number(a.n))) {
    const n = Number(r.n);
    total += n;
    const isProblematic = r.appKey == null || r.appKey === "unknown";
    if (isProblematic) problematic += n;
    console.log(`  ${(r.appKey ?? "(null)").padEnd(20)} → ${n}${isProblematic ? "  ⚠ legacy/unknown" : ""}`);
  }
  console.log(`\nTotal: ${total}, problematic (null/unknown): ${problematic}`);

  // For the problematic ones — do they have a templateType to fall back on?
  if (problematic > 0) {
    const fallbacks = await db
      .select({
        templateType: targetWebsites.templateType,
        n: sql<number>`COUNT(*)`,
      })
      .from(targetWebsites)
      .where(sql`${targetWebsites.appKey} IS NULL OR ${targetWebsites.appKey} = 'unknown'`)
      .groupBy(targetWebsites.templateType);
    console.log("\ntemplateType fallback for problematic rows:");
    for (const r of fallbacks) {
      console.log(`  ${(r.templateType ?? "(null)").padEnd(20)} → ${r.n}`);
    }
    console.log("\n⚠️  These rows would lose routing if templateType-first branch is removed.");
    console.log("   Backfill their appKey before proceeding with 4.3.");
  } else {
    console.log("\n✅ All target_websites have an appKey set — safe to remove templateType-first routing.");
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

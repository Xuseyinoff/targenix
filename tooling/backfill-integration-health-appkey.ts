/**
 * Backfills `integration_health.appKey` from `target_websites.appKey` for all
 * rows where it's still NULL after migration 0068. Idempotent — safe to re-run.
 *
 * Two cases:
 *   1. destinationId > 0 → join integration_destinations + target_websites
 *   2. destinationId = 0 (legacy single-dest) → join integrations.targetWebsiteId
 *      → target_websites
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Case 1: per-destination rows (destinationId > 0)
  const r1 = (await db.execute(sql`
    UPDATE integration_health ih
    INNER JOIN integration_destinations id ON id.id = ih.destinationId
    INNER JOIN target_websites tw ON tw.id = id.targetWebsiteId
    SET ih.appKey = tw.appKey
    WHERE ih.appKey IS NULL AND ih.destinationId > 0
  `)) as any;
  console.log("Per-destination backfill:", r1[0]?.affectedRows ?? "?", "rows");

  // Case 2: legacy single-dest rows (destinationId = 0)
  const r2 = (await db.execute(sql`
    UPDATE integration_health ih
    INNER JOIN integrations i ON i.id = ih.integrationId
    INNER JOIN target_websites tw ON tw.id = i.targetWebsiteId
    SET ih.appKey = tw.appKey
    WHERE ih.appKey IS NULL AND ih.destinationId = 0
  `)) as any;
  console.log("Legacy single-dest backfill:", r2[0]?.affectedRows ?? "?", "rows");

  const remaining = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM integration_health WHERE appKey IS NULL
  `)) as any;
  console.log("Still NULL after backfill:", Number(remaining[0][0].n));

  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });

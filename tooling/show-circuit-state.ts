/**
 * Snapshot of every per-destination circuit breaker plus the most recent
 * event log. Read-only. Safe to run against prod.
 *
 * Run:
 *   npx tsx tooling/show-circuit-state.ts                      # local DB
 *   MYSQL_PUBLIC_URL=... npx tsx tooling/show-circuit-state.ts # railway prod
 *
 * Output groups:
 *   1. Current state distribution (CLOSED / OPEN / HALF_OPEN counts)
 *   2. Per-destination state rows, joined with integrations.name / appKey
 *      so the operator can see which integration is affected
 *   3. Last 20 events (opened/closed/half_opened/probe_*) chronologically
 *   4. Shadow-mode counter: how often Phase 0 would have blocked
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const nowRes = (await db.execute(sql`SELECT NOW() AS now`)) as any;
  console.log(`\nDB time: ${nowRes[0][0].now}`);

  console.log("\n=== 1. State distribution ===");
  const distRes = (await db.execute(sql`
    SELECT state, COUNT(*) AS n
    FROM integration_health
    GROUP BY state
    ORDER BY state
  `)) as any;
  if (distRes[0].length === 0) {
    console.log("  (no integration_health rows yet — no failures observed)");
  } else {
    console.table(distRes[0]);
  }

  console.log("\n=== 2. Per-destination state ===");
  const rowsRes = (await db.execute(sql`
    SELECT
      ih.integrationId,
      ih.destinationId,
      ih.state,
      ih.cooldownLevel,
      ih.cooldownUntil,
      (ih.cooldownUntil IS NOT NULL AND ih.cooldownUntil <= NOW()) AS cooldownExpired,
      ih.consecutiveFailures AS consecFail,
      ih.windowFailures AS winFail,
      ih.windowSuccesses AS winOk,
      ih.lastErrorType,
      ih.manualLock,
      i.name AS integrationName,
      i.type AS integrationType
    FROM integration_health ih
    LEFT JOIN integrations i ON i.id = ih.integrationId
    ORDER BY
      FIELD(ih.state, 'OPEN', 'HALF_OPEN', 'CLOSED'),
      ih.consecutiveFailures DESC
    LIMIT 50
  `)) as any;
  if (rowsRes[0].length === 0) {
    console.log("  (no rows)");
  } else {
    console.table(rowsRes[0]);
  }

  console.log("\n=== 3. Last 20 events (recent first) ===");
  const evRes = (await db.execute(sql`
    SELECT
      e.createdAt,
      e.integrationId,
      e.destinationId,
      e.eventType,
      e.fromState,
      e.toState,
      LEFT(COALESCE(e.reason, ''), 60) AS reason,
      e.errorType
    FROM integration_health_events e
    WHERE e.eventType NOT LIKE 'shadow_%'
    ORDER BY e.id DESC
    LIMIT 20
  `)) as any;
  if (evRes[0].length === 0) {
    console.log("  (no transition events yet)");
  } else {
    console.table(evRes[0]);
  }

  console.log("\n=== 4. Shadow-mode would-have-blocked count (last 24h) ===");
  const shadowRes = (await db.execute(sql`
    SELECT
      eventType,
      COUNT(*) AS n,
      COUNT(DISTINCT integrationId, destinationId) AS uniqueDests
    FROM integration_health_events
    WHERE eventType LIKE 'shadow_%'
      AND createdAt >= NOW() - INTERVAL 24 HOUR
    GROUP BY eventType
  `)) as any;
  if (shadowRes[0].length === 0) {
    console.log("  (no shadow events in last 24h — scheduler may not have run since Phase 0 deployed)");
  } else {
    console.table(shadowRes[0]);
  }

  // Top destinations by shadow_would_block — these are the candidates for
  // Phase 1 enforcement.
  console.log("\n=== 5. Top would-be-blocked destinations (last 24h) ===");
  const topRes = (await db.execute(sql`
    SELECT
      e.integrationId,
      e.destinationId,
      COUNT(*) AS shadowBlocks,
      MAX(e.createdAt) AS lastBlock,
      MAX(i.name) AS integrationName
    FROM integration_health_events e
    LEFT JOIN integrations i ON i.id = e.integrationId
    WHERE e.eventType = 'shadow_would_block'
      AND e.createdAt >= NOW() - INTERVAL 24 HOUR
    GROUP BY e.integrationId, e.destinationId
    ORDER BY shadowBlocks DESC
    LIMIT 10
  `)) as any;
  if (topRes[0].length === 0) {
    console.log("  (none)");
  } else {
    console.table(topRes[0]);
  }

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

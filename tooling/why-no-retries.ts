/**
 * Why is the retry queue empty? Diagnose where FAILED orders are.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const nowRow = (await db.execute(sql`SELECT NOW() AS now`)) as any;
  console.log("DB time:", nowRow[0][0].now);

  // 1. Overall FAILED breakdown
  console.log("\n=== 1. All FAILED orders ===");
  const all = (await db.execute(sql`
    SELECT
      CASE
        WHEN attempts >= 3 THEN 'exhausted (attempts >= 3)'
        WHEN nextRetryAt IS NULL THEN 'orphan (attempts < 3, nextRetryAt=NULL)'
        WHEN nextRetryAt <= NOW() THEN 'due now'
        ELSE 'scheduled future'
      END AS bucket,
      COUNT(*) AS n
    FROM orders
    WHERE status='FAILED'
    GROUP BY bucket
    ORDER BY n DESC
  `)) as any;
  console.table(all[0]);

  // 2. The "scheduled future" — when are they due?
  console.log("\n=== 2. Scheduled future — distribution by minutes-from-now ===");
  const future = (await db.execute(sql`
    SELECT
      CASE
        WHEN nextRetryAt <= NOW() + INTERVAL 1 MINUTE THEN '< 1 min'
        WHEN nextRetryAt <= NOW() + INTERVAL 5 MINUTE THEN '1–5 min'
        WHEN nextRetryAt <= NOW() + INTERVAL 15 MINUTE THEN '5–15 min'
        WHEN nextRetryAt <= NOW() + INTERVAL 60 MINUTE THEN '15–60 min'
        WHEN nextRetryAt <= NOW() + INTERVAL 360 MINUTE THEN '1–6 hour'
        ELSE '> 6 hour'
      END AS bucket,
      COUNT(*) AS n,
      MIN(nextRetryAt) AS earliest,
      MAX(nextRetryAt) AS latest
    FROM orders
    WHERE status='FAILED' AND attempts < 3 AND nextRetryAt > NOW()
    GROUP BY bucket
    ORDER BY MIN(nextRetryAt)
  `)) as any;
  console.table(future[0]);

  // 3. Recent successful deliveries (last hour) — is the pipeline alive at all?
  console.log("\n=== 3. Pipeline aliveness — orders touched in last hour ===");
  const recent = (await db.execute(sql`
    SELECT status, COUNT(*) AS n, MIN(lastAttemptAt) AS earliest, MAX(lastAttemptAt) AS latest
    FROM orders
    WHERE lastAttemptAt >= NOW() - INTERVAL 1 HOUR
    GROUP BY status
  `)) as any;
  console.table(recent[0]);

  // 4. Earliest scheduled retry across the whole table
  console.log("\n=== 4. Where IS the next due retry? ===");
  const earliest = (await db.execute(sql`
    SELECT
      o.id, o.integrationId, o.destinationId, o.attempts, o.errorType,
      o.nextRetryAt,
      TIMESTAMPDIFF(SECOND, NOW(), o.nextRetryAt) AS secondsAway,
      i.name AS integrationName
    FROM orders o
    LEFT JOIN integrations i ON i.id = o.integrationId
    WHERE o.status='FAILED' AND o.attempts < 3 AND o.nextRetryAt IS NOT NULL
    ORDER BY o.nextRetryAt ASC
    LIMIT 5
  `)) as any;
  console.table(earliest[0]);

  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });

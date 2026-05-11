import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // 18 OPEN destinations + retryable order counts
  const r = (await db.execute(sql`
    SELECT
      ih.integrationId,
      ih.destinationId,
      ih.appKey,
      i.name AS integrationName,
      (SELECT COUNT(*) FROM orders o
         WHERE o.integrationId = ih.integrationId
           AND o.destinationId = ih.destinationId
           AND o.status = 'FAILED'
           AND o.attempts < 3
           AND o.nextRetryAt IS NOT NULL
           AND o.nextRetryAt <= NOW()) AS dueRetryable,
      (SELECT COUNT(*) FROM orders o
         WHERE o.integrationId = ih.integrationId
           AND o.destinationId = ih.destinationId
           AND o.status = 'FAILED'
           AND o.attempts < 3) AS totalFailedNotExhausted,
      (SELECT MAX(o.lastAttemptAt) FROM orders o
         WHERE o.integrationId = ih.integrationId
           AND o.destinationId = ih.destinationId) AS lastAttempt
    FROM integration_health ih
    LEFT JOIN integrations i ON i.id = ih.integrationId
    WHERE ih.state = 'OPEN'
    ORDER BY dueRetryable DESC
  `)) as any;
  console.table(r[0]);

  // Global retry queue health
  const q = (await db.execute(sql`
    SELECT
      COUNT(*) AS totalFailedNotExhausted,
      SUM(CASE WHEN nextRetryAt IS NOT NULL AND nextRetryAt <= NOW() THEN 1 ELSE 0 END) AS dueNow,
      SUM(CASE WHEN nextRetryAt IS NOT NULL AND nextRetryAt > NOW() THEN 1 ELSE 0 END) AS scheduledFuture,
      SUM(CASE WHEN nextRetryAt IS NULL THEN 1 ELSE 0 END) AS nullNext
    FROM orders
    WHERE status='FAILED' AND attempts < 3
  `)) as any;
  console.log("\nGlobal retry queue:", q[0][0]);

  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.error("DB unavailable");
    process.exit(1);
  }

  const nowRes = (await db.execute(sql`SELECT NOW() AS now`)) as any;
  console.log("DB vaqti:", nowRes[0][0].now);

  console.log("\n=== Retry navbati (status=FAILED AND attempts<3) ===");
  const queueRes = (await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN nextRetryAt IS NOT NULL AND nextRetryAt <= NOW() THEN 1 ELSE 0 END) AS due_now,
      SUM(CASE WHEN nextRetryAt IS NOT NULL AND nextRetryAt > NOW() THEN 1 ELSE 0 END) AS scheduled_future,
      SUM(CASE WHEN nextRetryAt IS NULL THEN 1 ELSE 0 END) AS no_nextretry,
      MIN(nextRetryAt) AS earliest_due,
      MAX(nextRetryAt) AS latest_scheduled
    FROM orders
    WHERE status='FAILED' AND attempts < 3
  `)) as any;
  console.log(queueRes[0][0]);

  console.log("\n=== FAILED orderlar — attempts taqsimoti ===");
  const attRes = (await db.execute(sql`
    SELECT attempts, COUNT(*) AS n
    FROM orders
    WHERE status='FAILED'
    GROUP BY attempts
    ORDER BY attempts
  `)) as any;
  console.table(attRes[0]);

  console.log("\n=== attempts >= 3 (exhausted) statistika ===");
  const exhCountRes = (await db.execute(sql`
    SELECT
      COUNT(*) AS total_exhausted,
      MAX(COALESCE(lastAttemptAt, updatedAt)) AS most_recent
    FROM orders
    WHERE attempts >= 3
  `)) as any;
  console.log(exhCountRes[0][0]);

  console.log("\n=== attempts >= 3 — oxirgi 10 ta ===");
  const exhRes = (await db.execute(sql`
    SELECT id, attempts, status, lastAttemptAt, updatedAt, errorType, LEFT(COALESCE(responseData, ''), 80) AS resp
    FROM orders
    WHERE attempts >= 3
    ORDER BY COALESCE(lastAttemptAt, updatedAt) DESC
    LIMIT 10
  `)) as any;
  console.table(exhRes[0]);

  console.log("\n=== Retry aktivligi (lastAttemptAt) ===");
  const actRes = (await db.execute(sql`
    SELECT
      SUM(CASE WHEN lastAttemptAt >= NOW() - INTERVAL 1 HOUR THEN 1 ELSE 0 END) AS last_1h,
      SUM(CASE WHEN lastAttemptAt >= NOW() - INTERVAL 6 HOUR THEN 1 ELSE 0 END) AS last_6h,
      SUM(CASE WHEN lastAttemptAt >= NOW() - INTERVAL 24 HOUR THEN 1 ELSE 0 END) AS last_24h,
      SUM(CASE WHEN lastAttemptAt >= NOW() - INTERVAL 7 DAY THEN 1 ELSE 0 END) AS last_7d,
      MAX(lastAttemptAt) AS last_attempt_any
    FROM orders
    WHERE attempts > 0
  `)) as any;
  console.log(actRes[0][0]);

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

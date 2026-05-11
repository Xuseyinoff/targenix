/**
 * One-off backfill: re-queue orphan retry orders.
 *
 * Sprint 1 / Item 1.2 left a brief window (commit 144d13d → 2542b92) where the
 * scheduler claim cleared nextRetryAt=NULL but retryFailedOrderDelivery
 * refused to pick them back up due to a now-stale guard. The bug is fixed in
 * 2542b92; this script unblocks the rows that were stranded by it.
 *
 * Run:
 *   npx tsx tooling/backfill-orphan-retries.ts                 # local DB
 *   MYSQL_PUBLIC_URL=... npx tsx tooling/backfill-orphan-retries.ts   # railway
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const beforeRes = (await db.execute(sql`
    SELECT COUNT(*) AS n
    FROM orders
    WHERE status='FAILED' AND attempts < 3 AND nextRetryAt IS NULL
  `)) as any;
  const before = Number(beforeRes[0][0].n);
  console.log(`Orphans (FAILED, attempts<3, nextRetryAt=NULL): ${before}`);

  if (before === 0) {
    console.log("Nothing to backfill.");
    await closeDb();
    return;
  }

  const upRes = (await db.execute(sql`
    UPDATE orders
    SET nextRetryAt = NOW()
    WHERE status='FAILED' AND attempts < 3 AND nextRetryAt IS NULL
  `)) as any;
  console.log(`Backfilled: affectedRows=${upRes[0]?.affectedRows ?? "?"}`);

  const dueRes = (await db.execute(sql`
    SELECT COUNT(*) AS n
    FROM orders
    WHERE status='FAILED' AND attempts < 3 AND nextRetryAt IS NOT NULL AND nextRetryAt <= NOW()
  `)) as any;
  console.log(`Now due for retry: ${Number(dueRes[0][0].n)}`);

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

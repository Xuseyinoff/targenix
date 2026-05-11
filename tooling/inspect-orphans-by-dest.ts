import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const r = (await db.execute(sql`
    SELECT
      o.integrationId,
      o.destinationId,
      i.name AS integrationName,
      COUNT(*) AS orphanCount,
      MAX(o.lastAttemptAt) AS lastAttempt,
      MAX(o.errorType) AS sampleErrorType,
      LEFT(MAX(JSON_UNQUOTE(JSON_EXTRACT(o.responseData, '$.error'))), 70) AS sampleErr
    FROM orders o
    LEFT JOIN integrations i ON i.id = o.integrationId
    WHERE o.status='FAILED' AND o.attempts < 3 AND o.nextRetryAt IS NULL
    GROUP BY o.integrationId, o.destinationId, i.name
    ORDER BY orphanCount DESC
    LIMIT 15
  `)) as any;
  console.table(r[0]);

  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });

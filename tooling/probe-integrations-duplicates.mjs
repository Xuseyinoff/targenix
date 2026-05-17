/**
 * Read-only prod probe — find existing duplicates on
 * (userId, formId, destinationId) where deletedAt IS NULL.
 *
 * If this returns >0, the unique-constraint migration will fail.
 *
 * Usage: railway run --service=targenix.uz node tooling/probe-integrations-duplicates.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[probe] No mysql:// URL in env.");
  process.exit(1);
}
console.log("[probe] Connecting to:", url.replace(/:\/\/[^@]+@/, "://<hidden>@"));
const conn = await mysql.createConnection({ uri: url });

try {
  // Total rows + null-stats
  const [totals] = await conn.query(`
    SELECT
      COUNT(*) AS total_rows,
      SUM(deletedAt IS NULL) AS live_rows,
      SUM(deletedAt IS NOT NULL) AS deleted_rows,
      SUM(formId IS NULL) AS null_formId,
      SUM(destinationId IS NULL) AS null_destinationId,
      SUM(formId IS NULL OR destinationId IS NULL) AS null_either
    FROM integrations
  `);
  console.log("[probe] Row stats:");
  console.table(totals);

  // Live duplicates — would block UNIQUE on (userId, formId, destinationId)
  // MySQL UNIQUE treats NULL as distinct, so rows with NULL formId or NULL destinationId
  // won't collide regardless. We still group them for visibility.
  const [dupes] = await conn.query(`
    SELECT userId, formId, destinationId, COUNT(*) AS cnt,
           GROUP_CONCAT(id ORDER BY id) AS ids,
           GROUP_CONCAT(DISTINCT name SEPARATOR ' | ') AS names
    FROM integrations
    WHERE deletedAt IS NULL
      AND formId IS NOT NULL
      AND destinationId IS NOT NULL
    GROUP BY userId, formId, destinationId
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 50
  `);
  console.log(`[probe] LIVE duplicates on (userId, formId, destinationId): ${dupes.length}`);
  if (dupes.length > 0) {
    console.table(dupes);
    console.log("[probe] ⚠️  Migration would FAIL if applied now. Cleanup required.");
  } else {
    console.log("[probe] ✅ Safe to add UNIQUE INDEX on (userId, formId, destinationId).");
  }

  // Also count cross-soft-delete duplicates (live + deleted with same key)
  // — these wouldn't block the migration but inform the restore-on-create UX
  const [crossDel] = await conn.query(`
    SELECT userId, formId, destinationId,
           SUM(deletedAt IS NULL) AS live,
           SUM(deletedAt IS NOT NULL) AS deleted
    FROM integrations
    WHERE formId IS NOT NULL AND destinationId IS NOT NULL
    GROUP BY userId, formId, destinationId
    HAVING live >= 1 AND deleted >= 1
    LIMIT 10
  `);
  console.log(`[probe] (Live + soft-deleted) collisions (informational): ${crossDel.length}`);
  if (crossDel.length > 0) console.table(crossDel);
} catch (err) {
  console.error("[probe] FATAL:", err.message);
  process.exit(1);
} finally {
  await conn.end();
}

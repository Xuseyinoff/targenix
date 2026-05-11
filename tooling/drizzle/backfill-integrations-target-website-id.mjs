/**
 * Backfill `integrations.targetWebsiteId` (dedicated column) from `config.targetWebsiteId` (JSON).
 *
 * Context: dedicated column was added in migration 0036; previous backfill missed 115 rows
 * (verified at HEAD: 51% of LEAD_ROUTING rows had NULL in the column despite the JSON having
 * the value). This script closes that gap so we can later strip duplicate keys from JSON
 * without breaking the 9 fallback read paths in leadService.ts / adminBackfillRouter.ts /
 * integrationsRouter.ts.
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/drizzle/backfill-integrations-target-website-id.mjs
 *   railway run --service targenix.uz node tooling/drizzle/backfill-integrations-target-website-id.mjs --apply
 *
 * Default mode is DRY-RUN — preview only. Pass --apply to execute the UPDATE.
 *
 * Safety:
 *   - Only updates rows where:
 *       type = 'LEAD_ROUTING'
 *       AND targetWebsiteId IS NULL
 *       AND JSON has $.targetWebsiteId
 *       AND the JSON value parses as a positive integer
 *   - Wraps in a transaction
 *   - Idempotent — re-runs are safe
 *   - Verifies target_websites.id exists before linking (skips dangling references)
 */
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("No mysql:// URL in env");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
try {
  console.log(`Mode: ${APPLY ? "APPLY (will UPDATE)" : "DRY-RUN (preview only)"}\n`);

  const [before] = await conn.query(`
    SELECT
      COUNT(*) AS total,
      SUM(targetWebsiteId IS NULL) AS null_col,
      SUM(targetWebsiteId IS NULL
          AND JSON_CONTAINS_PATH(config, 'one', '$.targetWebsiteId')) AS fillable
    FROM integrations WHERE type = 'LEAD_ROUTING'
  `);
  console.log("=== Before ===");
  console.log(`  total LEAD_ROUTING: ${before[0].total}`);
  console.log(`  targetWebsiteId NULL: ${before[0].null_col}`);
  console.log(`  fillable (NULL col + JSON has key): ${before[0].fillable}\n`);

  const [candidates] = await conn.query(`
    SELECT
      i.id,
      JSON_UNQUOTE(JSON_EXTRACT(i.config, '$.targetWebsiteId')) AS json_tw_id_raw,
      tw.id AS tw_exists
    FROM integrations i
    LEFT JOIN target_websites tw
      ON tw.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(i.config, '$.targetWebsiteId')) AS UNSIGNED)
    WHERE i.type = 'LEAD_ROUTING'
      AND i.targetWebsiteId IS NULL
      AND JSON_CONTAINS_PATH(i.config, 'one', '$.targetWebsiteId')
  `);

  let willUpdate = 0;
  let skipped_unparseable = 0;
  let skipped_dangling = 0;
  const updates = [];

  for (const row of candidates) {
    const parsed = Number(row.json_tw_id_raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      skipped_unparseable++;
      continue;
    }
    if (row.tw_exists == null) {
      skipped_dangling++;
      console.log(
        `  SKIP id=${row.id}: JSON targetWebsiteId=${row.json_tw_id_raw} → no matching target_websites row`,
      );
      continue;
    }
    willUpdate++;
    updates.push({ integrationId: row.id, twId: parsed });
  }

  console.log("=== Plan ===");
  console.log(`  candidates: ${candidates.length}`);
  console.log(`  will update: ${willUpdate}`);
  console.log(`  skip (unparseable JSON): ${skipped_unparseable}`);
  console.log(`  skip (dangling tw_id, target_website deleted): ${skipped_dangling}\n`);

  if (!APPLY) {
    console.log("DRY-RUN finished. Re-run with --apply to execute.");
    process.exit(0);
  }

  if (willUpdate === 0) {
    console.log("Nothing to update.");
    process.exit(0);
  }

  await conn.beginTransaction();
  try {
    for (const u of updates) {
      await conn.query("UPDATE integrations SET targetWebsiteId = ? WHERE id = ? AND targetWebsiteId IS NULL", [
        u.twId,
        u.integrationId,
      ]);
    }
    await conn.commit();
    console.log(`Applied ${willUpdate} updates.\n`);
  } catch (e) {
    await conn.rollback();
    throw e;
  }

  const [after] = await conn.query(`
    SELECT
      COUNT(*) AS total,
      SUM(targetWebsiteId IS NULL) AS null_col
    FROM integrations WHERE type = 'LEAD_ROUTING'
  `);
  console.log("=== After ===");
  console.log(`  total LEAD_ROUTING: ${after[0].total}`);
  console.log(`  targetWebsiteId NULL: ${after[0].null_col}`);
} finally {
  await conn.end();
}

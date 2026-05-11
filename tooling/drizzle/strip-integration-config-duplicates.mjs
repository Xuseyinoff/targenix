/**
 * Strip duplicate dedicated-column keys from `integrations.config` JSON.
 *
 * Step 4 of the integrations.config dedup migration. Preceded by:
 *   - Step 1 (commit d9f2d84): backfill `targetWebsiteId` column from JSON
 *   - Step 2 (commit c4c7302): wizard sends top-level fields, stops echoing
 *     them inside config JSON; server prefers top-level, falls back to JSON
 *
 * After this script, the dedicated columns remain authoritative and the JSON
 * config holds only fields that have no column equivalent (fieldMappings,
 * nameField, phoneField, variableFields, targetWebsiteName, targetTemplateType).
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/drizzle/strip-integration-config-duplicates.mjs
 *   railway run --service targenix.uz node tooling/drizzle/strip-integration-config-duplicates.mjs --apply
 *
 * Default mode is DRY-RUN — preview only. Pass --apply to execute the UPDATE.
 *
 * Safety:
 *   - Only LEAD_ROUTING rows are touched.
 *   - Only rows that currently contain at least one of the duplicate keys.
 *   - Transactional — single BEGIN / COMMIT.
 *   - Idempotent — re-runs strip nothing on already-clean rows.
 *   - Pre-flight schema consistency check: aborts if any row has the JSON
 *     duplicate present while the matching column is NULL (would lose data).
 *
 * Damage on old-tab regression: if a user's stale browser tab saves an
 * integration with the legacy wizard shape AFTER strip runs, the JSON for
 * THAT row gains the keys back. This is purely cosmetic — server still
 * extracts and writes to dedicated columns. Re-run is safe at any time.
 */
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("No mysql:// URL in env");
  process.exit(1);
}

const STRIP_KEYS = [
  "$.pageId",
  "$.formId",
  "$.pageName",
  "$.formName",
  "$.targetWebsiteId",
  "$.facebookAccountId",
  "$.accountId", // legacy alias for facebookAccountId
];

const conn = await mysql.createConnection(url);
try {
  console.log(`Mode: ${APPLY ? "APPLY (will UPDATE)" : "DRY-RUN (preview only)"}\n`);

  console.log("=== Pre-flight schema consistency check ===");
  const [[guard]] = await conn.query(`
    SELECT
      SUM(pageId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.pageId')) AS pageId_unsafe,
      SUM(formId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.formId')) AS formId_unsafe,
      SUM(pageName IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.pageName')) AS pageName_unsafe,
      SUM(formName IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.formName')) AS formName_unsafe,
      SUM(targetWebsiteId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.targetWebsiteId')) AS twId_unsafe,
      SUM(facebookAccountId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.facebookAccountId')) AS fbId_unsafe
    FROM integrations WHERE type = 'LEAD_ROUTING'
  `);
  let totalUnsafe = 0;
  for (const k of Object.keys(guard)) {
    const v = Number(guard[k]);
    if (v > 0) console.log(`  NOTE ${k}: ${v} row(s) — will be SKIPPED to preserve JSON data`);
    totalUnsafe += v;
  }
  if (totalUnsafe === 0) {
    console.log("  OK — every JSON duplicate has its dedicated column populated.\n");
  } else {
    console.log(`  Strip will exclude rows where any column is NULL while the matching JSON key exists.\n`);
  }

  console.log("=== Before ===");
  const [[before]] = await conn.query(`
    SELECT
      COUNT(*) AS total,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.pageId')) AS has_pageId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.formId')) AS has_formId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.pageName')) AS has_pageName,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.formName')) AS has_formName,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.targetWebsiteId')) AS has_twId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.facebookAccountId')) AS has_fbId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.accountId')) AS has_accountId
    FROM integrations WHERE type = 'LEAD_ROUTING'
  `);
  console.log(`  total LEAD_ROUTING: ${before.total}`);
  for (const [k, v] of Object.entries(before)) {
    if (k === "total") continue;
    console.log(`  ${k}: ${v}`);
  }

  // Selection: row has at least one duplicate key AND no NULL-column / JSON-key
  // mismatch that would lose data on strip.
  const SAFE_TO_STRIP_CLAUSE = `
    type = 'LEAD_ROUTING'
    AND (
      JSON_CONTAINS_PATH(config, 'one', '$.pageId') OR
      JSON_CONTAINS_PATH(config, 'one', '$.formId') OR
      JSON_CONTAINS_PATH(config, 'one', '$.pageName') OR
      JSON_CONTAINS_PATH(config, 'one', '$.formName') OR
      JSON_CONTAINS_PATH(config, 'one', '$.targetWebsiteId') OR
      JSON_CONTAINS_PATH(config, 'one', '$.facebookAccountId') OR
      JSON_CONTAINS_PATH(config, 'one', '$.accountId')
    )
    AND NOT (pageId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.pageId'))
    AND NOT (formId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.formId'))
    AND NOT (pageName IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.pageName'))
    AND NOT (formName IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.formName'))
    AND NOT (targetWebsiteId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.targetWebsiteId'))
    AND NOT (facebookAccountId IS NULL AND JSON_CONTAINS_PATH(config, 'one', '$.facebookAccountId'))
  `;

  const [[planRow]] = await conn.query(
    `SELECT COUNT(*) AS n FROM integrations WHERE ${SAFE_TO_STRIP_CLAUSE}`,
  );
  console.log(`\n=== Plan ===`);
  console.log(`  rows to strip: ${planRow.n}`);
  if (totalUnsafe > 0) {
    console.log(`  rows skipped (NULL-column / JSON-key mismatch): ${totalUnsafe}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN finished. Re-run with --apply to execute.");
    process.exit(0);
  }

  if (planRow.n === 0) {
    console.log("\nNothing to strip.");
    process.exit(0);
  }

  await conn.beginTransaction();
  try {
    const [result] = await conn.query(
      `UPDATE integrations
       SET config = JSON_REMOVE(config, ${STRIP_KEYS.map(() => "?").join(", ")})
       WHERE ${SAFE_TO_STRIP_CLAUSE}`,
      STRIP_KEYS,
    );
    await conn.commit();
    const affected = result?.affectedRows ?? "?";
    console.log(`\nApplied. affectedRows=${affected}`);
  } catch (e) {
    await conn.rollback();
    throw e;
  }

  console.log("\n=== After ===");
  const [[after]] = await conn.query(`
    SELECT
      COUNT(*) AS total,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.pageId')) AS has_pageId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.formId')) AS has_formId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.pageName')) AS has_pageName,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.formName')) AS has_formName,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.targetWebsiteId')) AS has_twId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.facebookAccountId')) AS has_fbId,
      SUM(JSON_CONTAINS_PATH(config, 'one', '$.accountId')) AS has_accountId
    FROM integrations WHERE type = 'LEAD_ROUTING'
  `);
  console.log(`  total LEAD_ROUTING: ${after.total}`);
  for (const [k, v] of Object.entries(after)) {
    if (k === "total") continue;
    console.log(`  ${k}: ${v}`);
  }
} finally {
  await conn.end();
}

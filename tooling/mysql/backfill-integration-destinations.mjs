/**
 * Backfill `integration_destinations` from the legacy 1:1 link on
 * `integrations`.
 *
 * Source of truth for existing rows:
 *   1. integrations.targetWebsiteId (dedicated column)
 *   2. integrations.config.targetWebsiteId (JSON fallback — used for very
 *      old rows created before the dedicated column was added)
 *
 * Behaviour:
 *   - Selects every LEAD_ROUTING integration that has at least one of those
 *     two sources pointing at a target website.
 *   - For each, INSERT IGNOREs a row into integration_destinations with
 *     position=0 and enabled=1. INSERT IGNORE makes the script idempotent:
 *     re-running is cheap and safe, existing rows are left alone thanks to
 *     the UNIQUE(integrationId, targetWebsiteId) constraint.
 *   - Validates that the referenced target website actually exists BEFORE
 *     attempting the insert — otherwise the FK in migration 0044 would
 *     reject the row and we'd log noise instead of a clean skip.
 *
 * CLI flags:
 *   --dry-run       : compute the deltas but do not write anything.
 *   --user-id=<id>  : restrict to one user — handy for targeted QA.
 *   --verbose       : print per-row decisions.
 *
 * Usage (local):
 *   MYSQL_PUBLIC_URL=mysql://... node tooling/mysql/backfill-integration-destinations.mjs --dry-run
 *
 * Usage (Railway):
 *   railway run node tooling/mysql/backfill-integration-destinations.mjs
 *
 * The script prints a summary at the end: total / inserted / skipped /
 * dangling (target missing). Running the same flags twice should yield
 * inserted=0 on the second pass.
 */

import "dotenv/config";
import mysql from "mysql2/promise";

// ─── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const userArg = args.find((a) => a.startsWith("--user-id="));
const USER_ID = userArg ? Number(userArg.split("=")[1]) : null;
if (userArg && !Number.isFinite(USER_ID)) {
  console.error("Invalid --user-id value.");
  process.exit(1);
}

// ─── connection ──────────────────────────────────────────────────────────
const url =
  process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("No DB URL found. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
console.log(`[backfill-dest] Connected (dry-run=${DRY_RUN}, userFilter=${USER_ID ?? "none"})`);

// ─── helpers ─────────────────────────────────────────────────────────────
function extractTwIdFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const raw = cfg.targetWebsiteId;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
}

// ─── 1. load candidate integrations ──────────────────────────────────────
const whereUser = USER_ID ? `AND userId = ${USER_ID}` : "";
const [rows] = await conn.execute(
  `SELECT id, userId, targetWebsiteId, config
     FROM integrations
    WHERE type = 'LEAD_ROUTING' ${whereUser}`,
);
console.log(`[backfill-dest] Inspecting ${rows.length} LEAD_ROUTING integration(s)`);

// ─── 2. resolve tw ids ───────────────────────────────────────────────────
/** candidates: { integrationId, targetWebsiteId } */
const candidates = [];
let missingBothSources = 0;
for (const row of rows) {
  let cfg;
  try {
    cfg = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  } catch {
    cfg = null;
  }
  const twFromCol = row.targetWebsiteId ?? null;
  const twFromCfg = extractTwIdFromConfig(cfg);
  const twId = twFromCol ?? twFromCfg;
  if (!twId) {
    missingBothSources++;
    if (VERBOSE) console.log(`  id=${row.id} userId=${row.userId} — no targetWebsiteId anywhere, skipping`);
    continue;
  }
  candidates.push({ integrationId: row.id, targetWebsiteId: twId });
}

console.log(`[backfill-dest] candidates: ${candidates.length}, no-target: ${missingBothSources}`);

// ─── 3. verify target websites exist (avoid FK errors) ──────────────────
const uniqueTwIds = [...new Set(candidates.map((c) => c.targetWebsiteId))];
const existingTws = new Set();
if (uniqueTwIds.length > 0) {
  const placeholders = uniqueTwIds.map(() => "?").join(",");
  const [twRows] = await conn.execute(
    `SELECT id FROM target_websites WHERE id IN (${placeholders})`,
    uniqueTwIds,
  );
  for (const r of twRows) existingTws.add(Number(r.id));
}

// ─── 4. insert or count ─────────────────────────────────────────────────
let inserted = 0;
let skippedDupe = 0;
let dangling = 0;

for (const c of candidates) {
  if (!existingTws.has(c.targetWebsiteId)) {
    dangling++;
    if (VERBOSE) console.log(
      `  integration ${c.integrationId} → target_website ${c.targetWebsiteId} (DANGLING — skipped)`,
    );
    continue;
  }

  if (DRY_RUN) {
    if (VERBOSE) console.log(
      `  [dry-run] would INSERT IGNORE integration=${c.integrationId} → tw=${c.targetWebsiteId}`,
    );
    // Count as inserted for the summary; duplicates will be revealed by a
    // real run. We cannot know in dry-run whether the row already exists
    // without hitting the DB per row — keep this simple and transparent.
    inserted++;
    continue;
  }

  const [res] = await conn.execute(
    `INSERT IGNORE INTO integration_destinations
       (integrationId, targetWebsiteId, position, enabled)
     VALUES (?, ?, 0, 1)`,
    [c.integrationId, c.targetWebsiteId],
  );
  if (res.affectedRows === 1) {
    inserted++;
    if (VERBOSE) console.log(
      `  INSERT integration=${c.integrationId} → tw=${c.targetWebsiteId}`,
    );
  } else {
    skippedDupe++;
    if (VERBOSE) console.log(
      `  exists integration=${c.integrationId} → tw=${c.targetWebsiteId}`,
    );
  }
}

// ─── 5. summary ─────────────────────────────────────────────────────────
await conn.end();
const mode = DRY_RUN ? "DRY-RUN" : "APPLIED";
console.log("─".repeat(60));
console.log(`[backfill-dest] ${mode} — candidates=${candidates.length}`);
console.log(`  inserted:     ${inserted}`);
console.log(`  already-set:  ${skippedDupe}`);
console.log(`  dangling tw:  ${dangling}`);
console.log(`  no-target:    ${missingBothSources}`);
if (dangling > 0) {
  console.log("");
  console.log(`[backfill-dest] NOTE: ${dangling} integration(s) reference a`);
  console.log(`  target_website that no longer exists. These were skipped`);
  console.log(`  to avoid FK errors. They already fail silently in dispatch`);
  console.log(`  today — nothing new broke. You can clean them up manually.`);
}

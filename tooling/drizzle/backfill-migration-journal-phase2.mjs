/**
 * backfill-migration-journal-phase2.mjs
 *
 * Phase 2 reconciliation (AUDIT_REPORT.md Section B.3).
 *
 * The audit identified 8 migrations whose DDL is present in prod but whose
 * row is missing from `__drizzle_migrations`. Without this backfill, the
 * next `pnpm db:push` / `drizzle-kit migrate` would see them as "unapplied"
 * and try to re-run the SQL — which fails on non-idempotent CREATE TABLE
 * / ADD COLUMN statements and aborts the deploy.
 *
 * This script INSERTs 8 missing rows. Idempotent: each insert is preceded by
 * an existence check on (hash) so re-running is a no-op.
 *
 * 19 OTHER missing rows (0030, 0031, 0042-0045, 0069-0079, 0083, 0084 +
 * two dup-numbered files) are intentionally OUT OF SCOPE for this script
 * — they're documented in drizzle/MIGRATION_HISTORY.md as known historical
 * drift. The team uses `tooling/apply-NNNN-*.mjs` pattern for all schema
 * changes, so `db:push` is not in routine use; the older drift is harmless
 * unless someone runs db:push.
 *
 * Usage (run from a Railway shell with prod env vars):
 *   railway run node tooling/drizzle/backfill-migration-journal-phase2.mjs
 *
 * Or with explicit MYSQL_URL:
 *   MYSQL_URL=mysql://... node tooling/drizzle/backfill-migration-journal-phase2.mjs
 *
 * Hashes computed from disk via:
 *   crypto.createHash('sha256').update(fs.readFileSync('drizzle/<file>.sql')).digest('hex')
 *
 * The `created_at` values are sequential immediately after the last existing
 * journal entry (1779833280004 = 0084_telegram_pending_chats_claimed_by),
 * mirroring how drizzle-kit assigns timestamps for batched migrations.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

/**
 * The 8 migrations to backfill, in idx-append order.
 * `when` values continue the existing journal sequence so idx remains
 * monotonic with timestamp.
 */
const ROWS = [
  { file: "0054_drop_connection_app_specs.sql",              when: 1779833280005 },
  { file: "0060_drop_connections_google_account_id_final.sql", when: 1779833280006 },
  { file: "0085_insights_phase1.sql",                        when: 1779833280007 },
  { file: "0086_campaign_daily_insights.sql",                when: 1779833280008 },
  { file: "0087_insights_fix_collation.sql",                 when: 1779833280009 },
  { file: "0088_orders_payout_currency.sql",                 when: 1779833280010 },
  { file: "0089_insights_phase4_fx_and_pipeline.sql",        when: 1779833280011 },
  { file: "0090_orders_offer_name.sql",                      when: 1779833280012 },
];

function hashFile(relPath) {
  const buf = readFileSync(join(REPO_ROOT, "drizzle", relPath));
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[backfill] No mysql:// URL in env. Set MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL.");
  process.exit(1);
}

console.log("[backfill] Connecting to:", url.replace(/:\/\/[^@]+@/, "://<hidden>@"));
const conn = await mysql.createConnection({ uri: url });

let inserted = 0;
let skipped = 0;
let errors = 0;

try {
  for (const row of ROWS) {
    const hash = hashFile(row.file);
    try {
      const [existing] = await conn.query(
        "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
        [hash],
      );
      if (existing.length > 0) {
        console.log(`[backfill] SKIP ${row.file} — hash ${hash.slice(0, 12)}… already present (id=${existing[0].id})`);
        skipped++;
        continue;
      }
      await conn.query(
        "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
        [hash, row.when],
      );
      console.log(`[backfill] INSERT ${row.file} → hash=${hash.slice(0, 12)}… when=${row.when}`);
      inserted++;
    } catch (err) {
      console.error(`[backfill] ERROR on ${row.file}:`, err.message);
      errors++;
    }
  }
} finally {
  await conn.end();
}

console.log("");
console.log(`[backfill] DONE — inserted=${inserted}, skipped=${skipped}, errors=${errors}`);
if (errors > 0) process.exit(1);

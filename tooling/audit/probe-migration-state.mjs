/**
 * probe-migration-state.mjs — read-only probe of production DB to reconcile
 * `drizzle/meta/_journal.json` against actual applied state.
 *
 * Runs every SELECT in `check-migration-state.sql` and prints the result.
 * No mutations. Safe to run against prod.
 *
 * Usage:
 *   railway run node tooling/audit/probe-migration-state.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[probe] No mysql:// URL found in env. Set MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL.");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });

function section(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

async function q(label, sql, params = []) {
  try {
    const [rows] = await conn.query(sql, params);
    console.log(`\n--- ${label} ---`);
    if (Array.isArray(rows) && rows.length === 0) {
      console.log("(0 rows)");
    } else if (Array.isArray(rows)) {
      console.table(rows);
    } else {
      console.log(rows);
    }
  } catch (err) {
    console.log(`\n--- ${label} ---`);
    console.log(`ERROR: ${err.message}`);
  }
}

try {
  // ── 1. Find the drizzle migration tracking table ─────────────────────────
  section("BLOCK 1 — Migration tracking table discovery");
  await q("SHOW TABLES LIKE '%migration%'", "SHOW TABLES LIKE '%migration%'");
  await q("SHOW TABLES LIKE '%drizzle%'", "SHOW TABLES LIKE '%drizzle%'");

  // ── 2. Full migration history ────────────────────────────────────────────
  section("BLOCK 2 — Every applied migration in chronological order");
  await q(
    "__drizzle_migrations contents",
    `SELECT
       id,
       hash,
       created_at,
       FROM_UNIXTIME(created_at / 1000) AS applied_at_human
     FROM \`__drizzle_migrations\`
     ORDER BY created_at ASC, id ASC`,
  );

  // ── 3. Independent verification via information_schema ───────────────────
  section("BLOCK 3 — Schema-side verification of presumed-missing migrations");

  await q(
    "0054 — connection_app_specs table (0 = applied/dropped, 1 = still present)",
    `SELECT COUNT(*) AS rows_in_info_schema
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'connection_app_specs'`,
  );

  await q(
    "0060 — connections.googleAccountId column (0 = applied/dropped, 1 = still present)",
    `SELECT COUNT(*) AS rows_in_info_schema
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'connections'
        AND column_name = 'googleAccountId'`,
  );

  await q(
    "0085 — users.baseCurrency",
    `SELECT COUNT(*) AS present
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'baseCurrency'`,
  );
  await q(
    "0085 — ad_accounts.bmId",
    `SELECT COUNT(*) AS present
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'ad_accounts' AND column_name = 'bmId'`,
  );
  await q(
    "0085 — orders.offerId",
    `SELECT COUNT(*) AS present
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'offerId'`,
  );
  await q(
    "0085 — fact_attribution_daily table",
    `SELECT COUNT(*) AS present
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'fact_attribution_daily'`,
  );

  await q(
    "0086 — campaign_daily_insights table",
    `SELECT COUNT(*) AS present
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'campaign_daily_insights'`,
  );

  await q(
    "0087 — fact_attribution_daily table collation (expect utf8mb4)",
    `SELECT table_collation
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'fact_attribution_daily'`,
  );

  await q(
    "0088 — orders.payoutCurrency",
    `SELECT COUNT(*) AS present
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'payoutCurrency'`,
  );

  await q(
    "0089 — fx_rates table",
    `SELECT COUNT(*) AS present
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'fx_rates'`,
  );
  await q(
    "0089 — fact_attribution_daily.pipelineAmount",
    `SELECT COUNT(*) AS present
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'fact_attribution_daily'
        AND column_name = 'pipelineAmount'`,
  );

  await q(
    "0090 — orders.offerName",
    `SELECT COUNT(*) AS present
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'offerName'`,
  );

  // ── 4. Duplicate-number files: schema artifacts ──────────────────────────
  section("BLOCK 4 — Duplicate-numbered .sql files: are their artifacts in prod?");

  await q(
    "0025_dup — password_reset_tokens table",
    `SELECT COUNT(*) AS present
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'password_reset_tokens'`,
  );

  await q(
    "0027_dup — destination_templates table",
    `SELECT COUNT(*) AS present
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'destination_templates'`,
  );

  // ── 5. Sanity: row counts ────────────────────────────────────────────────
  section("BLOCK 5 — Sanity (prod is not empty)");
  await q(
    "row counts",
    `SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
     UNION ALL SELECT 'leads', COUNT(*) FROM leads
     UNION ALL SELECT 'orders', COUNT(*) FROM orders
     UNION ALL SELECT 'destinations', COUNT(*) FROM destinations`,
  );

  console.log("\n[probe] Done. All queries read-only.\n");
} finally {
  await conn.end();
}

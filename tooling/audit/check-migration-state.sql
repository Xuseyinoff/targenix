-- =============================================================================
-- Migration journal reconciliation — production state probe
-- =============================================================================
-- Run against PRODUCTION (read-only). The output is what reconciles the
-- on-disk `_journal.json` to reality. Do NOT mutate anything; all queries are
-- SELECT-only.
--
-- How to run:
--   1. Railway dashboard → MySQL plugin → "Query" tab, paste each block, run.
--   2. OR `railway run mysql --table -e "..."` if you have the CLI.
--
-- Paste each numbered block's results back to the assistant. The assistant
-- will not modify any tracking files until it has seen real prod output.
-- =============================================================================


-- ── 1. Find the drizzle migration tracking table ─────────────────────────────
-- Drizzle usually names it `__drizzle_migrations`. Confirm before query (2).
SHOW TABLES LIKE '%migration%';
SHOW TABLES LIKE '%drizzle%';


-- ── 2. Every applied migration in chronological order ───────────────────────
-- Expected ~81 rows if the journal is still ahead of disk; could be more if
-- backfill-migration-journal-0026-0027.mjs has been re-run.
-- Each row: id (auto-increment), hash (sha256 of migration .sql), created_at
-- (Unix ms timestamp the row was inserted).
SELECT
  id,
  hash,
  created_at,
  FROM_UNIXTIME(created_at / 1000) AS applied_at_human
FROM `__drizzle_migrations`
ORDER BY created_at ASC, id ASC;


-- ── 3. Independent verification: do the schema artifacts from each
--       presumed-missing migration actually exist? ──────────────────────────
-- If a migration is "missing from journal" but its DDL DOES exist in the
-- schema, that proves it was applied (via tooling/apply-*.mjs). If the DDL
-- is NOT in the schema, the migration was never applied and we must NOT
-- backfill the journal for it.

-- 0054_drop_connection_app_specs — should have DROPPED this table.
--   Expected: 0 rows (table absent → migration applied).
SELECT 'connection_app_specs' AS check_for, COUNT(*) AS rows_in_info_schema
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'connection_app_specs';

-- 0060_drop_connections_google_account_id_final — should have DROPPED this column.
--   Expected: 0 rows (column absent → migration applied).
SELECT 'connections.googleAccountId' AS check_for, COUNT(*) AS rows_in_info_schema
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'connections'
  AND column_name = 'googleAccountId';

-- 0085_insights_phase1 — should have CREATED these columns/tables.
--   Expected: each row count > 0 (artifact present → migration applied).
SELECT '0085: users.baseCurrency' AS check_for, COUNT(*) AS present
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'baseCurrency';

SELECT '0085: ad_accounts.bmId' AS check_for, COUNT(*) AS present
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'ad_accounts' AND column_name = 'bmId';

SELECT '0085: orders.offerId' AS check_for, COUNT(*) AS present
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'offerId';

SELECT '0085: fact_attribution_daily table' AS check_for, COUNT(*) AS present
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'fact_attribution_daily';

-- 0086_campaign_daily_insights — new table.
SELECT '0086: campaign_daily_insights table' AS check_for, COUNT(*) AS present
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'campaign_daily_insights';

-- 0087_insights_fix_collation — utf8mb4 collation on fact table.
SELECT '0087: fact_attribution_daily collation' AS check_for, table_collation
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'fact_attribution_daily';

-- 0088_orders_payout_currency — new column.
SELECT '0088: orders.payoutCurrency' AS check_for, COUNT(*) AS present
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'payoutCurrency';

-- 0089_insights_phase4_fx_and_pipeline — new fx_rates table and orders.pipelineAmount.
SELECT '0089: fx_rates table' AS check_for, COUNT(*) AS present
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'fx_rates';

SELECT '0089: fact_attribution_daily.pipelineAmount' AS check_for, COUNT(*) AS present
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'fact_attribution_daily' AND column_name = 'pipelineAmount';

-- 0090_orders_offer_name — new column.
SELECT '0090: orders.offerName' AS check_for, COUNT(*) AS present
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'offerName';


-- ── 4. Duplicate-number files: do their schema artifacts exist? ─────────────
-- 0025_password_reset_tokens — should have CREATED password_reset_tokens.
SELECT '0025_dup: password_reset_tokens table' AS check_for, COUNT(*) AS present
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'password_reset_tokens';

-- 0027_destination_templates — should have CREATED destination_templates.
SELECT '0027_dup: destination_templates table' AS check_for, COUNT(*) AS present
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'destination_templates';


-- ── 5. Row count for context (sanity check production isn't empty) ──────────
SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL SELECT 'leads', COUNT(*) FROM leads
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'destinations', COUNT(*) FROM destinations;

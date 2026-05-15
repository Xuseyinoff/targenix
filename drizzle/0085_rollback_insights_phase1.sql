-- Rollback for 0085 — drops everything the forward migration added.
--
-- Safe to run multiple times; each step is guarded.
--
-- Data loss:
--   - fact_attribution_daily rows are DERIVED from leads/orders/
--     campaign_insights — they can be rebuilt by re-running the
--     insightsRollupScheduler against the same window. Nothing is
--     permanently lost when the table is dropped.
--   - orders.offerId and orders.payoutAmount snapshots ARE lost on
--     rollback. They can be back-filled later (offerId from
--     destinations.templateConfig, payoutAmount from a fresh CRM sync
--     pass calling /getOrderDetails).
--   - users.baseCurrency falls back to 'USD' on every account if it is
--     re-added later.

-- ── 5. fact_attribution_daily ────────────────────────────────────────────
DROP TABLE IF EXISTS `fact_attribution_daily`;

-- ── 4. orders.payoutAmount ───────────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'payoutAmount'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE orders DROP COLUMN payoutAmount',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 3. orders.offerId (+ its index) ──────────────────────────────────────
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND index_name = 'idx_orders_user_offer_created'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_orders_user_offer_created ON orders',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'offerId'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE orders DROP COLUMN offerId',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 2. ad_accounts.bmName / bmId (+ index) ───────────────────────────────
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'ad_accounts'
     AND index_name = 'idx_ad_accounts_bm_id'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_ad_accounts_bm_id ON ad_accounts',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'ad_accounts'
     AND column_name = 'bmName'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE ad_accounts DROP COLUMN bmName',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'ad_accounts'
     AND column_name = 'bmId'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE ad_accounts DROP COLUMN bmId',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 1. users.baseCurrency ────────────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'baseCurrency'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE users DROP COLUMN baseCurrency',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

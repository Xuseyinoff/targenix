-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0085 — Insights (affiliate-BI) Phase 1.
--
-- Adds the minimum schema needed to ship the /insights surface:
--   1. users.baseCurrency           — per-user reporting currency (UZS or USD).
--   2. ad_accounts.bmId / bmName    — Facebook Business Manager grouping.
--   3. orders.offerId               — offer snapshot at order creation (the
--                                     destination's templateConfig.offer_id
--                                     value, copied so analytics never has to
--                                     reach into JSON at query time).
--   4. orders.payoutAmount          — revenue per delivered order, captured
--                                     from sotuvchi's /getOrderDetails
--                                     response (`order.pay_for`, integer UZS).
--                                     Phase 3 wires the CRM-sync adapter to
--                                     populate this; column added now so
--                                     adapter code can ship after schema is
--                                     live (memory rule: DB before code).
--   5. fact_attribution_daily       — the single rollup table that powers the
--                                     /insights page. One row per
--                                     (user, date, full FB attribution chain,
--                                     offer). Refreshed every 15 min by the
--                                     insightsRollupScheduler worker with a
--                                     7-day rebuild window (covers sotuvchi's
--                                     3–5 day delivery lag).
--
-- Currency model (Phase 1):
--   - Every user has one base currency (UZS or USD).
--   - Rollup row carries a `currency` snapshot so historical rows survive a
--     user changing their base currency later.
--   - Amounts are stored as BIGINT in the SMALLEST unit of the row's
--     currency (UZS: 1 = 1 so'm; USD: 1 = 1 cent). FX conversion is v2 — not
--     in this migration. Each row is self-consistent.
--
-- Dimension NULL handling:
--   - MySQL UNIQUE indexes treat NULLs as distinct, which would defeat the
--     UPSERT semantics. Every grouping column is therefore NOT NULL with an
--     empty-string default (`''`) used as the "unknown / not-applicable"
--     sentinel. The rollup writer normalises NULL → '' before INSERT.
--
-- Idempotency:
--   - All column adds are guarded by information_schema lookups.
--   - The table uses CREATE TABLE IF NOT EXISTS.
--   - Safe to re-run.
--
-- Cost:
--   - MySQL 8 InnoDB ADD COLUMN with no default (or constant default) is
--     INSTANT DDL — metadata-only. The users.baseCurrency add carries a
--     constant default 'USD' so it is also instant. None of these block
--     writes to leads / orders / users.
--   - fact_attribution_daily starts empty; first rollup run populates it.
--
-- Rollback: see 0085_rollback_insights_phase1.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- ── 1. users.baseCurrency ────────────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'baseCurrency'
);
SET @stmt := IF(@col_exists = 0,
  "ALTER TABLE users ADD COLUMN baseCurrency VARCHAR(8) NOT NULL DEFAULT 'USD'",
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 2. ad_accounts.bmId / bmName ─────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'ad_accounts'
     AND column_name = 'bmId'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE ad_accounts ADD COLUMN bmId VARCHAR(64) NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'ad_accounts'
     AND column_name = 'bmName'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE ad_accounts ADD COLUMN bmName VARCHAR(255) NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- Query index for "all ad accounts under BM X" lookups.
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'ad_accounts'
     AND index_name = 'idx_ad_accounts_bm_id'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_ad_accounts_bm_id ON ad_accounts (bmId)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 3. orders.offerId ────────────────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'offerId'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE orders ADD COLUMN offerId VARCHAR(64) NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- Per-offer time-series and "top offers" queries scan (userId, offerId, createdAt).
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND index_name = 'idx_orders_user_offer_created'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_orders_user_offer_created ON orders (userId, offerId, createdAt)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 4. orders.payoutAmount ───────────────────────────────────────────────
-- Stored as INT in the smallest unit of the row's currency snapshot.
-- For sotuvchi today: integer UZS (e.g. 35000). NULL until CRM sync widens
-- the adapter in Phase 3 to capture `order.pay_for` from /getOrderDetails.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'payoutAmount'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE orders ADD COLUMN payoutAmount INT NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 5. fact_attribution_daily ────────────────────────────────────────────
-- The one rollup table that powers the /insights surface.
--
-- Grain: 1 row per (user, date, full FB attribution chain, offer).
--
-- Cardinality bound: a single user posting 100 ads with 5 offers each
-- yields at most ~500 rows/day. At 1000 active users × 365 days that's
-- ~180M rows worst case — fits comfortably in InnoDB with the indexes
-- below. Realistic load will be 1-2 orders of magnitude smaller.
CREATE TABLE IF NOT EXISTS `fact_attribution_daily` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `userId`          INT NOT NULL,
  `date`            DATE NOT NULL,

  -- Dimension columns — NOT NULL + '' sentinel so the composite UNIQUE
  -- key can drive ON DUPLICATE KEY UPDATE upserts safely. The rollup
  -- writer normalises NULL → '' before INSERT.
  `bmId`            VARCHAR(64)  NOT NULL DEFAULT '',
  `adAccountId`     VARCHAR(64)  NOT NULL DEFAULT '',
  `campaignId`      VARCHAR(100) NOT NULL DEFAULT '',
  `adsetId`         VARCHAR(100) NOT NULL DEFAULT '',
  `adId`            VARCHAR(100) NOT NULL DEFAULT '',
  `pageId`          VARCHAR(128) NOT NULL DEFAULT '',
  `formId`          VARCHAR(128) NOT NULL DEFAULT '',
  `offerId`         VARCHAR(64)  NOT NULL DEFAULT '',

  -- Lead-funnel counters (from leads table).
  `leads`           INT NOT NULL DEFAULT 0,
  `enriched`        INT NOT NULL DEFAULT 0,
  `enrichErrors`    INT NOT NULL DEFAULT 0,

  -- Delivery-funnel counters (from orders table).
  `sent`            INT NOT NULL DEFAULT 0,
  `failed`          INT NOT NULL DEFAULT 0,

  -- CRM-funnel counters (from orders.crmStatus).
  `accepted`        INT NOT NULL DEFAULT 0,
  `delivered`       INT NOT NULL DEFAULT 0,
  `held`            INT NOT NULL DEFAULT 0,
  `rejected`        INT NOT NULL DEFAULT 0,
  `trash`           INT NOT NULL DEFAULT 0,

  -- Money — in the SMALLEST unit of `currency` (UZS so'm / USD cents).
  `spendAmount`     BIGINT NOT NULL DEFAULT 0,  -- attributed FB ad spend
  `revenueAmount`   BIGINT NOT NULL DEFAULT 0,  -- SUM(orders.payoutAmount) for delivered rows
  `currency`        VARCHAR(8) NOT NULL DEFAULT 'USD',  -- snapshot of users.baseCurrency at rollup time

  `updatedAt`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),

  -- UPSERT target. Composite covers every dimension; '' sentinel keeps
  -- "unknown" rows mergeable so we never duplicate "rows where bmId is
  -- not yet backfilled".
  UNIQUE KEY `uniq_fact_attribution` (
    `userId`, `date`,
    `bmId`, `adAccountId`,
    `campaignId`, `adsetId`, `adId`,
    `pageId`, `formId`, `offerId`
  ),

  -- Primary access pattern — "show me everything for user X over date range".
  KEY `idx_fact_attr_user_date`     (`userId`, `date`),
  -- Group-by-campaign drill-down.
  KEY `idx_fact_attr_user_campaign` (`userId`, `campaignId`, `date`),
  -- Group-by-offer drill-down.
  KEY `idx_fact_attr_user_offer`    (`userId`, `offerId`, `date`),
  -- Group-by-BM drill-down (top-level of the FB attribution dropdown).
  KEY `idx_fact_attr_user_bm`       (`userId`, `bmId`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

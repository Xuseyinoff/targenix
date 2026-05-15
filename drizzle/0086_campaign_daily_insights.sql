-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0086 — campaign_daily_insights table (Phase 2).
--
-- Adds the daily-granularity spend cache the Insights rollup needs to fill
-- `fact_attribution_daily.spendAmount`.
--
-- Why a new table rather than extending campaign_insights?
--   campaign_insights stores preset-aggregated totals (today / yesterday /
--   last_7d / last_30d), keyed by datePreset. We cannot allocate one
--   "last_30d total" across the rollup's daily grain — we need per-day
--   rows. Extending the existing table would mean either (a) adding a
--   `date` column and breaking every existing read, or (b) using a magic
--   datePreset value. Both are uglier than a sibling table.
--
-- Source:
--   GET /{ad_account_id}/insights
--     ?level=campaign
--     &time_increment=1
--     &date_preset=last_7d
--     &fields=campaign_id,spend,impressions,clicks,leads
--
--   FB returns N campaigns × 7 days = ~140 rows per ad account in one call.
--   `time_increment=1` is the magic flag that produces day-level rows.
--
-- Currency semantics:
--   - `currency` is a snapshot of `ad_accounts.currency` at sync time.
--   - `spend` is stored as BIGINT in the SMALLEST unit of that currency
--     (UZS so'm units / USD cents). Matches the storage convention in
--     fact_attribution_daily.spendAmount.
--   - No FX conversion in v1. If a user's `baseCurrency` differs from an
--     ad account's currency, the rollup skips that row and logs a warning
--     — v2 will add an FX layer.
--
-- Idempotency:
--   - CREATE TABLE IF NOT EXISTS — safe to re-run.
--
-- Cost:
--   - Empty table on create; INSTANT DDL.
--   - Subsequent sync writes are bounded — ~7 days × N campaigns per user.
--     A heavy user with 200 active campaigns sees ~1400 row UPSERTs/hour.
--
-- Rollback: see 0086_rollback_campaign_daily_insights.sql.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `campaign_daily_insights` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `userId`          INT NOT NULL,
  `fbAdAccountId`   VARCHAR(64)  NOT NULL,
  `fbCampaignId`    VARCHAR(64)  NOT NULL,
  /** YYYY-MM-DD; matches fact_attribution_daily.date semantics (UTC). */
  `date`            DATE         NOT NULL,
  /** Smallest-unit integer in `currency`. UZS so'm units / USD cents. */
  `spend`           BIGINT       NOT NULL DEFAULT 0,
  /** Snapshot of ad_accounts.currency at sync time. Allows the rollup to
   *  short-circuit when it doesn't match the user's reporting currency. */
  `currency`        VARCHAR(8)   NOT NULL DEFAULT 'USD',
  `impressions`     INT          NOT NULL DEFAULT 0,
  `clicks`          INT          NOT NULL DEFAULT 0,
  /** Lead count as reported by FB's own conversion attribution. NOT the
   *  same as our `leads` table count — kept for cross-checking. */
  `leadsReported`   INT          NOT NULL DEFAULT 0,
  `syncedAt`        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),

  /** UPSERT target — one row per (user, campaign, day). */
  UNIQUE KEY `uniq_campaign_day` (`userId`, `fbCampaignId`, `date`),

  /** Rollup join hot-path: WHERE userId=? AND date BETWEEN ? AND ?. */
  KEY `idx_user_date`             (`userId`, `date`),
  /** Per-campaign drill: WHERE userId=? AND fbCampaignId=? AND date IN (…). */
  KEY `idx_user_campaign_date`    (`userId`, `fbCampaignId`, `date`),
  /** Per-ad-account ops queries (rare). */
  KEY `idx_user_ad_account`       (`userId`, `fbAdAccountId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

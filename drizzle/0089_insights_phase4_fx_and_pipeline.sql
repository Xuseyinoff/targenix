-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0089 — Insights Phase 4: FX rates + pipeline column.
--
-- Two additions, both required by the Phase 4 work:
--
--   1. fx_rates                                  (new table)
--      Daily USD/UZS exchange rates pulled from the Central Bank of
--      Uzbekistan (CBU) JSON API. The rollup worker joins this so it can
--      report Revenue / Spend in the user's chosen baseCurrency even when
--      the underlying transaction is in another currency.
--
--   2. fact_attribution_daily.pipelineAmount     (new column)
--      Money that's "in-flight" — sotuvchi has committed a `pay_for` for
--      an order whose status is past `new` but not yet `delivered`
--      (contacted / in_progress / sent / callback / success). Surfaces in
--      the breakdown table as a Pipeline column so users see what's
--      expected to land on top of the realized Revenue. Does NOT feed
--      Profit — we stay conservative on Profit = Revenue − Spend.
--
-- Currency model recap (unchanged by this migration; documented for
-- reference):
--   - Every money column on Insights tables is stored in the SMALLEST unit
--     of the row's `currency` field (UZS so'm units / USD cents).
--   - Phase 4 introduces CROSS-currency reads via the new fx_rates table;
--     individual rows still store native amounts. The conversion happens at
--     rollup time so historical fact_attribution rows always reflect the
--     rate observed on the lead's date, not an after-the-fact reinterpretation.
--
-- Idempotency:
--   - fx_rates uses CREATE TABLE IF NOT EXISTS.
--   - pipelineAmount add is guarded by information_schema lookup.
--
-- Cost:
--   - fx_rates is empty on create — INSTANT DDL.
--   - ADD COLUMN with constant default 0 — also INSTANT DDL on MySQL 8.
--
-- Rollback: see 0089_rollback_insights_phase4_fx_and_pipeline.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- ── 1. fx_rates ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `fx_rates` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  /** Effective date the rate covers (YYYY-MM-DD). One row per day per
   *  currency pair — v1 has just one pair (UZS↔USD), keyed by date only. */
  `date`         DATE NOT NULL,
  /** Rate: how many UZS so'm equal 1 USD. CBU publishes this daily; e.g.
   *  12700.5000 = 1 USD costs 12,700.5 so'm on this date. DECIMAL(10,4)
   *  covers up to 999,999.9999 — far above any realistic UZS/USD rate. */
  `uzs_per_usd`  DECIMAL(10,4) NOT NULL,
  /** Source tag. 'CBU' for the official Central Bank pull; 'manual' if
   *  an admin overrode a value. Kept loose for forward-compat with
   *  future providers (Yandex, etc). */
  `source`       VARCHAR(32) NOT NULL DEFAULT 'CBU',
  /** When this row was last refreshed from the source. */
  `fetched_at`   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  /** UPSERT target — one rate per date. */
  UNIQUE KEY `uniq_fx_date` (`date`),
  /** Hot-path index for the rollup's COALESCE-with-fallback JOIN
   *  (`date = ? OR fallback to MAX(date) <= ?`). */
  KEY          `idx_fx_date`  (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 2. fact_attribution_daily.pipelineAmount ────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'fact_attribution_daily'
     AND column_name = 'pipelineAmount'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE fact_attribution_daily ADD COLUMN pipelineAmount BIGINT NOT NULL DEFAULT 0',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

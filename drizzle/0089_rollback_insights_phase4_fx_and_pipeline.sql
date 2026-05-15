-- Rollback for 0089 — drops fx_rates and pipelineAmount.
--
-- Data loss:
--   - fx_rates rows are derivable by re-running the CBU sync (the source
--     of truth is the Central Bank, not us). No permanent loss.
--   - pipelineAmount values are re-computable by the next rollup pass once
--     the column is re-added. Safe to roll back.

-- ── 2. fact_attribution_daily.pipelineAmount ────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'fact_attribution_daily'
     AND column_name = 'pipelineAmount'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE fact_attribution_daily DROP COLUMN pipelineAmount',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ── 1. fx_rates ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS `fx_rates`;

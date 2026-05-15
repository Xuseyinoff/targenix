-- Rollback for 0086 — drop campaign_daily_insights.
--
-- Data loss:
--   - Rows are derivable by re-running the FB insights sync. Nothing is
--     permanently lost.
--   - fact_attribution_daily.spendAmount values written during the rollup
--     window will stay at their last-rolled value until the next rollup
--     pass; once the table is gone, every fresh rollup re-inserts spend=0.
--     That matches the Phase 1 baseline behaviour — safe.

DROP TABLE IF EXISTS `campaign_daily_insights`;

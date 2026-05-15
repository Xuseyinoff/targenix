-- Rollback for 0087 — reverts the Insights tables to the original
-- utf8mb4_unicode_ci collation.
--
-- You almost certainly do NOT want to run this: utf8mb4_unicode_ci is
-- what caused the ER_CANT_AGGREGATE_2COLLATIONS errors in the rollup
-- worker that 0087 fixes. Kept only for completeness; calling code
-- never reads this file.

ALTER TABLE `fact_attribution_daily`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `campaign_daily_insights`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

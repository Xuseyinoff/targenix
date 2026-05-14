-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for migration 0082 — drop metric_snapshots.
--
-- Data loss: yes — all metric history rows are lost. Export first if
-- the historical series is worth preserving:
--   SELECT * FROM metric_snapshots
--    INTO OUTFILE '/tmp/metric_snapshots_backup.csv'
--    FIELDS TERMINATED BY ',' ENCLOSED BY '"'
--    LINES TERMINATED BY '\n';
--
-- Idempotency: DROP TABLE IF EXISTS — safe to re-run.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS `metric_snapshots`;

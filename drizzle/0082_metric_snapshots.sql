-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0082 — metric snapshots table.
--
-- Roadmap #7 phase C: durable history for the in-process counters
-- (failed_orders, oauth_errors) and DB-side gauges (failed_orders_db,
-- retry_queue_size). Before this table, counters reset on process
-- restart and the only output was console.log under METRICS_LOG=1 — no
-- history, no graphs, no recovery after a deploy.
--
-- The metric_snapshots row schema is intentionally narrow:
--   - kind = "counter": interval delta (the capture scheduler reads
--                       AND resets the in-process counter atomically,
--                       so each row represents activity since the
--                       previous snapshot)
--   - kind = "gauge":   point-in-time reading at snapshotAt
--
-- New metric names are added by writing rows with that name — no
-- schema change. The `meta` JSON lets a future metric attach dimensions
-- (replica id, tenant id, etc.) without ALTER TABLE.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS — safe to re-run.
-- Rollback:    see 0082_rollback_metric_snapshots.sql.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `metric_snapshots` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `snapshotAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `metric`     VARCHAR(64) NOT NULL,
  `kind`       VARCHAR(16) NOT NULL,
  `value`      INT NOT NULL,
  `meta`       JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_metric_snapshots_metric_time` (`metric`, `snapshotAt`),
  KEY `idx_metric_snapshots_time`        (`snapshotAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

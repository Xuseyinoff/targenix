-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0091 — secondary indexes on `destinations` + legacy-name cleanup.
--
-- Context: AUDIT_REPORT.md Section B.4 said `destinations` had ZERO
-- secondary indexes. Pre-apply probe revealed one legacy index
-- (`idx_target_websites_connection_id`) left over from the
-- target_websites → destinations rename in migration 0069 — the audit
-- read schema.ts, which didn't declare it, and missed it. Without this
-- migration, queries on `(userId)` or `(userId, appKey)` full-scan the
-- table.
--
-- Operations (in order):
--   1. CREATE idx_destinations_user_id          (userId)
--        Drives the bread-and-butter per-tenant list — destinations.list,
--        any router pulling all of a user's destinations.
--   2. CREATE idx_destinations_user_app         (userId, appKey)
--        Covers the lead-routing hot path that filters by (userId, appKey)
--        when dispatching by appKey (resolveAdapterKey → dispatchDelivery).
--   3. CREATE idx_destinations_connection_id    (connectionId)
--        Used by connections.disconnect to fan out and clear the
--        connection link from every destination that referenced it.
--   4. DROP   idx_target_websites_connection_id (connectionId)
--        Legacy name. Same column the new index in step 3 covers; this
--        cleanup matches the pattern from 0073 / 0075 (rename_legacy_
--        index_names). Ordering matters: step 3 runs FIRST so the
--        column is always covered by at least one index — no query-plan
--        regression window.
--
-- Cost: MySQL 8 InnoDB CREATE/DROP INDEX is ONLINE (ALGORITHM=INPLACE)
-- — reads and writes continue throughout. On the prod destinations
-- table (64 rows at apply time) every operation is sub-100ms.
--
-- Idempotency: each operation is guarded by an information_schema.statistics
-- lookup. Safe to re-run any number of times.
--
-- Rollback: see 0091_rollback_destinations_indexes.sql (drops the 3 new
-- indexes and re-creates the legacy index name).
-- ──────────────────────────────────────────────────────────────────────────

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_destinations_user_id'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_destinations_user_id ON destinations (userId)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_destinations_user_app'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_destinations_user_app ON destinations (userId, appKey)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_destinations_connection_id'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_destinations_connection_id ON destinations (connectionId)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- Step 4: drop the legacy index that was orphaned by the
-- target_websites → destinations table rename in 0069.
-- Same column (connectionId), wrong name. Following the pattern
-- established by 0073 and 0075.
SET @legacy_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_target_websites_connection_id'
);
SET @stmt := IF(@legacy_exists = 1,
  'DROP INDEX idx_target_websites_connection_id ON destinations',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0069 — rename `target_websites` → `destinations`,
--                  `integration_destinations` → `integration_routes`.
--
-- Strategy: rename + view-backed backward compatibility.
--   1. RENAME TABLE on InnoDB acquires an exclusive metadata lock for the
--      duration of the rename itself (typically <100 ms for tables of our
--      size — target_websites ~30 rows, integration_destinations ~230 rows
--      in production on 2026-05-12).
--   2. After rename, CREATE VIEW restores the OLD name as a single-table
--      pass-through. MySQL marks single-table SELECT * views as fully
--      updatable, so INSERT/UPDATE/DELETE through the view route to the
--      renamed underlying table — every existing code path that still
--      reads `target_websites` keeps working without code change.
--   3. Once every caller is migrated to the new name (separate PRs), a
--      follow-up migration will DROP these views.
--
-- Idempotency: each rename + view block is guarded so re-running the
-- migration on a partially-applied DB is safe.
--
-- Rollback: see 0069_rollback_rename_destinations.sql (committed alongside).
-- ──────────────────────────────────────────────────────────────────────────

-- 1. target_websites → destinations
DROP VIEW IF EXISTS target_websites;

-- Only rename if the source table still has the legacy name AND the
-- destination name is free. Either condition false → migration is a no-op.
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'target_websites'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'destinations'
);
SET @rename_sql := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE target_websites TO destinations',
  'DO 0');
PREPARE stmt FROM @rename_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Re-create the legacy name as a backward-compatible view.
CREATE OR REPLACE VIEW target_websites AS SELECT * FROM destinations;


-- 2. integration_destinations → integration_routes
DROP VIEW IF EXISTS integration_destinations;

SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_destinations'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_routes'
);
SET @rename_sql := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE integration_destinations TO integration_routes',
  'DO 0');
PREPARE stmt FROM @rename_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE OR REPLACE VIEW integration_destinations AS SELECT * FROM integration_routes;

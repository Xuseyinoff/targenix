-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for migration 0069 — restore `target_websites` and
-- `integration_destinations` as real tables (and remove the views).
--
-- Safe to run repeatedly. Use this script if anything goes wrong AFTER
-- 0069 applied but BEFORE any code starts depending on the new names
-- (e.g. before pushing the schema TS change).
-- ──────────────────────────────────────────────────────────────────────────

-- 1. integration_destinations
DROP VIEW IF EXISTS integration_destinations;

SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_routes'
    AND table_type = 'BASE TABLE'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_destinations'
    AND table_type = 'BASE TABLE'
);
SET @rename_sql := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE integration_routes TO integration_destinations',
  'DO 0');
PREPARE stmt FROM @rename_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- 2. target_websites
DROP VIEW IF EXISTS target_websites;

SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'destinations'
    AND table_type = 'BASE TABLE'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'target_websites'
    AND table_type = 'BASE TABLE'
);
SET @rename_sql := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE destinations TO target_websites',
  'DO 0');
PREPARE stmt FROM @rename_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0073 — rename legacy index names to match the post-0069
-- table names. Pure cosmetic SQL identifier cleanup.
--
-- old → new:
--   integrations:
--     idx_integrations_target_website_id     → idx_integrations_destination_id
--   integration_routes:
--     idx_integration_destinations_integration      → idx_integration_routes_integration
--     idx_integration_destinations_target_website   → idx_integration_routes_destination
--     uniq_integration_destination                  → uniq_integration_route
--
-- Cost: MySQL 8 `RENAME INDEX` is INSTANT DDL (metadata only). Indexes
-- keep their B-tree pages intact; only the identifier changes. No
-- runtime impact — queries reference indexes by column, not by name.
--
-- Idempotency: each rename is guarded — if the destination index name
-- already exists OR the source is gone, the rename becomes a no-op.
--
-- Rollback: see 0073_rollback_rename_legacy_index_names.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. integrations.idx_integrations_target_website_id
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND index_name = 'idx_integrations_target_website_id'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND index_name = 'idx_integrations_destination_id'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integrations RENAME INDEX idx_integrations_target_website_id TO idx_integrations_destination_id',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 2. integration_routes.idx_integration_destinations_integration
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_destinations_integration'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_routes_integration'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME INDEX idx_integration_destinations_integration TO idx_integration_routes_integration',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 3. integration_routes.idx_integration_destinations_target_website
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_destinations_target_website'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_routes_destination'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME INDEX idx_integration_destinations_target_website TO idx_integration_routes_destination',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 4. integration_routes.uniq_integration_destination
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'uniq_integration_destination'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'uniq_integration_route'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME INDEX uniq_integration_destination TO uniq_integration_route',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;

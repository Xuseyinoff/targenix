-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0073 — restore legacy index names. Symmetric and guarded.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. integrations.idx_integrations_destination_id → idx_integrations_target_website_id
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND index_name = 'idx_integrations_destination_id'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND index_name = 'idx_integrations_target_website_id'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integrations RENAME INDEX idx_integrations_destination_id TO idx_integrations_target_website_id',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 2. integration_routes.idx_integration_routes_integration → idx_integration_destinations_integration
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_routes_integration'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_destinations_integration'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME INDEX idx_integration_routes_integration TO idx_integration_destinations_integration',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 3. integration_routes.idx_integration_routes_destination → idx_integration_destinations_target_website
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_routes_destination'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'idx_integration_destinations_target_website'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME INDEX idx_integration_routes_destination TO idx_integration_destinations_target_website',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 4. integration_routes.uniq_integration_route → uniq_integration_destination
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'uniq_integration_route'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND index_name = 'uniq_integration_destination'
);
SET @stmt := IF(@src_exists >= 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME INDEX uniq_integration_route TO uniq_integration_destination',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;

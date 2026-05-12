-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0071 — restore `destinationId` → `targetWebsiteId` on
-- both tables. Guarded the same way as the forward migration.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. integrations.destinationId → integrations.targetWebsiteId
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND column_name = 'destinationId'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND column_name = 'targetWebsiteId'
);
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'ALTER TABLE integrations RENAME COLUMN destinationId TO targetWebsiteId',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 2. integration_routes.destinationId → integration_routes.targetWebsiteId
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND column_name = 'destinationId'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND column_name = 'targetWebsiteId'
);
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME COLUMN destinationId TO targetWebsiteId',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;

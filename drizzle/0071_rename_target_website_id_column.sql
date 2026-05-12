-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0071 — rename SQL column `targetWebsiteId` → `destinationId`
-- on both `integrations` and `integration_routes`.
--
-- Context: 0069 renamed the TABLES (target_websites → destinations,
-- integration_destinations → integration_routes). The FK columns kept
-- their legacy SQL names so the rename could ship without touching
-- callers; Drizzle was wired with `destinationId: int("targetWebsiteId")`
-- to keep the TS side modern. This migration finishes the rename at the
-- SQL level so column name = TS key.
--
-- Cost: MySQL 8 `RENAME COLUMN` is an INSTANT DDL operation (metadata
-- only, no table rebuild). Indexes follow the column automatically. The
-- exclusive metadata lock is held for under 100 ms on production-sized
-- tables (integrations ≈ a few hundred rows, integration_routes ≈ 230
-- rows on 2026-05-12).
--
-- Idempotency: each rename is guarded — if the destination column
-- already exists OR the source column is gone, the rename becomes a
-- no-op. Safe to re-run.
--
-- Rollback: see 0071_rollback_rename_target_website_id_column.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. integrations.targetWebsiteId → integrations.destinationId
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND column_name = 'targetWebsiteId'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
    AND column_name = 'destinationId'
);
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'ALTER TABLE integrations RENAME COLUMN targetWebsiteId TO destinationId',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;


-- 2. integration_routes.targetWebsiteId → integration_routes.destinationId
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND column_name = 'targetWebsiteId'
);
SET @dst_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'integration_routes'
    AND column_name = 'destinationId'
);
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'ALTER TABLE integration_routes RENAME COLUMN targetWebsiteId TO destinationId',
  'DO 0');
PREPARE p FROM @stmt;
EXECUTE p;
DEALLOCATE PREPARE p;

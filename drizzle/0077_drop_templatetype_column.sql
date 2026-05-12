-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0077 — drop the legacy `destinations.templateType` column.
--
-- Context: `templateType` was the original destination-type discriminator
-- (sotuvchi / 100k / custom / telegram / google-sheets / http-api-key).
-- Migration 0049 introduced `appKey` as the modern discriminator and 0051/
-- 0052 backfilled + made it NOT NULL. By 2026-05-12 runtime delivery read
-- only `appKey` (resolveAdapterKey) — `templateType` survived purely as
-- an API input/storage sentinel.
--
-- After Phase 1-3 of this commit arc:
--   • Server input schemas no longer accept templateType (only appKey).
--   • Server inserts no longer write templateType (column had default).
--   • Server reads use site.appKey everywhere.
--   • Drizzle schema.ts removed the templateType field.
--   • Client mutation payloads send appKey; client display reads d.appKey.
--
-- This migration drops the SQL column. MySQL 8 `ALTER TABLE ... DROP COLUMN`
-- on InnoDB is an INSTANT operation (metadata only) — no table rebuild,
-- no data movement.
--
-- Idempotency: guarded — re-running is a no-op when the column is gone.
--
-- Rollback: see 0077_rollback_drop_templatetype_column.sql. Note that
-- rollback creates the column with the historic default "custom" — all
-- new rows get that sentinel value; pre-drop column values are lost.
-- ──────────────────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND column_name = 'templateType'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE destinations DROP COLUMN templateType',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

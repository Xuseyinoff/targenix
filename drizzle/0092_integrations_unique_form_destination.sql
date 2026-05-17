-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0092 — UNIQUE INDEX preventing duplicate (user, form, destination)
-- routings on `integrations`.
--
-- Context: Yuboraman exploration (references/yuboraman-integration-creation-flow.md)
-- showed competitors guard against creating a second integration that maps
-- the same FB lead form to the same destination platform. Without this
-- guard, a user can accidentally double-route a form and double-deliver
-- every lead. Prod audit on 2026-05-17 found 1 live duplicate
-- (id=600099 + id=600174, user 1893798) — cleaned up via
-- tooling/cleanup-duplicate-integration-600099.mjs before applying this
-- migration.
--
-- Why a FUNCTIONAL unique index (not plain UNIQUE on the 3 columns):
--   MySQL UNIQUE enforces across ALL rows, including soft-deleted ones.
--   2 (live + deleted) cross-deletion collisions exist in prod — both
--   legitimate (user deleted a routing, then re-created the same one).
--   A plain UNIQUE would reject those. Including `deletedAt` in the
--   unique tuple doesn't help: NULL values are distinct in MySQL UNIQUE,
--   so two live rows with the same key would still collide-pass.
--
--   The functional index below collapses the unique key to NULL for any
--   row that's either soft-deleted OR missing a formId/destinationId.
--   NULL is distinct in MySQL UNIQUE, so those rows pass through; only
--   live + complete-routing rows participate. Requires MySQL 8.0.13+
--   (Railway runs MySQL 8.0+).
--
-- Operations:
--   1. CREATE the functional unique index — fails if any live duplicate
--      pre-exists (pre-flight tooling/probe-integrations-duplicates.mjs
--      asserts zero before this runs).
--
-- Cost: MySQL 8 InnoDB CREATE UNIQUE INDEX is ALGORITHM=INPLACE for tables
-- without conflicting keys — reads continue, writes briefly stall.
-- 336 rows in prod at apply time → sub-100ms.
--
-- Idempotency: guarded by information_schema lookup.
--
-- Rollback: drop the index (0092_rollback_*).
-- ──────────────────────────────────────────────────────────────────────────

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'integrations'
     AND index_name = 'uniq_integrations_live_form_dest'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX uniq_integrations_live_form_dest ON integrations (
     ((CASE
        WHEN deletedAt IS NULL
         AND formId IS NOT NULL
         AND destinationId IS NOT NULL
        THEN CONCAT_WS(''|'', userId, formId, destinationId)
        ELSE NULL
      END))
   )',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

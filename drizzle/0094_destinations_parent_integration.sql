-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0094 — destinations.parentIntegrationId.
--
-- Destinations Cleanup Sprint, PR 2/4. Adds a nullable column that flags a
-- destination as private to a single integration. The semantics:
--
--   parentIntegrationId IS NULL  → shared destination (current behaviour;
--                                  every existing row stays this way)
--   parentIntegrationId IS NOT NULL → private to that integration; the
--                                  destination picker, Connections page,
--                                  and any "reuse this destination from
--                                  another integration" path filter it out.
--
-- Why nullable + default-shared:
--   Production has zero generic-HTTP destinations and ~268 shared CPA-
--   template references across integrations (audit 2026-05-18). Defaulting
--   to shared preserves every existing row exactly as-is — no backfill, no
--   surprise behaviour change.
--
-- Why INT vs FK constraint:
--   Drizzle convention in this repo is INT columns + application-level
--   integrity (see destinations.connectionId / destinations.templateId —
--   neither carries a real FK). PR 3 of this sprint will land the cleanup
--   cascade that deletes the destination when its parent integration is
--   hard-deleted, replacing what a CASCADE constraint would otherwise do.
--
-- Index:
--   idx_destinations_parent_integration — covers the PR 3 cleanup query
--     ("DELETE FROM destinations WHERE parentIntegrationId = ?") and the
--     list-filter query ("WHERE parentIntegrationId IS NULL OR
--     parentIntegrationId = ?"). Both lookups would otherwise scan the
--     full destinations table for users with many integrations.
--
-- Idempotency: schema-introspection guard at apply time. The ADD COLUMN
-- statement itself is not idempotent (MySQL errors on duplicate column),
-- so the apply script checks information_schema first and skips the DDL
-- if the column already exists. Same pattern for the index.
--
-- Cost: ALGORITHM=INPLACE, LOCK=NONE — online schema change on the
-- destinations table (60-ish rows in prod, but the algorithm is
-- size-independent and won't block dispatch).
--
-- Rollback: see 0094_rollback_destinations_parent_integration.sql.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE `destinations`
  ADD COLUMN `parentIntegrationId` INT NULL,
  ALGORITHM=INPLACE, LOCK=NONE;

CREATE INDEX `idx_destinations_parent_integration`
  ON `destinations` (`parentIntegrationId`);

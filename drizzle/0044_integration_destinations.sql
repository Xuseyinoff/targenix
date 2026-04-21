-- Migration 0044: integration_destinations — multi-destination fan-out scaffold.
--
-- Phase 4 / Commit 4. ADDITIVE ONLY.
--
-- Goal: let a single LEAD_ROUTING integration deliver to N target_websites,
-- matching the Make.com pattern where one "scenario" fans out to many
-- destination modules. Today the link is a single `integrations.targetWebsiteId`
-- column (1:1). This migration introduces the N-side join table that will
-- eventually replace that column.
--
-- Zero behaviour change at deploy time:
--   - The new table is empty until the separate backfill script
--     (tooling/mysql/backfill-integration-destinations.mjs) runs.
--   - The existing `integrations.targetWebsiteId` column stays intact and
--     remains the source of truth for dispatch until Commit 6.
--   - Dispatch code in leadService.ts is NOT touched by this commit — it
--     still reads the legacy column, so no live delivery can regress.
--
-- Commit 4 adds dual-write to keep the new table in sync whenever
-- integrations are created / updated / deleted. Commit 5 will introduce
-- the feature-flagged dual-read + fan-out loop that actually consumes it.
--
-- Rollback is safe: DROP TABLE integration_destinations; nothing else
-- references this table yet.

--> statement-breakpoint

CREATE TABLE `integration_destinations` (
  `id`              int           NOT NULL AUTO_INCREMENT,
  -- Parent integration — a LEAD_ROUTING row in `integrations`.
  -- ON DELETE CASCADE: when the integration is removed, all its destination
  -- mappings disappear with it (matches the current expectation that
  -- dropping an integration stops all deliveries for it).
  `integrationId`   int           NOT NULL,
  -- The destination row driving delivery. ON DELETE CASCADE mirrors the
  -- legacy implicit behaviour: today `integrations.targetWebsiteId` simply
  -- dangles when the destination is deleted and dispatch fails silently.
  -- Cascading here is the cleaner successor — no orphan rows to reconcile.
  `targetWebsiteId` int           NOT NULL,
  -- Fan-out order. All rows sit at 0 for now (single-destination parity);
  -- the wizard in Commit 5 lets users drag rows to reorder.
  `position`        int           NOT NULL DEFAULT 0,
  -- Allow disabling a single destination without deleting the row, so
  -- users can temporarily stop delivery to e.g. a Telegram chat while
  -- keeping the mapping for later.
  `enabled`         boolean       NOT NULL DEFAULT TRUE,
  -- Reserved for Make.com-style per-destination filter rules (Phase 5+).
  -- NULL today; no code path reads it yet.
  `filterJson`      json          NULL,
  `createdAt`       timestamp     NOT NULL DEFAULT (now()),
  `updatedAt`       timestamp     NOT NULL DEFAULT (now()) ON UPDATE now(),

  CONSTRAINT `integration_destinations_id` PRIMARY KEY (`id`),

  -- Prevent an integration from accidentally listing the same destination
  -- twice. The wizard should enforce this in the UI too; the DB is the
  -- last-line guarantee.
  CONSTRAINT `uniq_integration_destination`
    UNIQUE (`integrationId`, `targetWebsiteId`),

  -- Hot-path index for dispatch: SELECT … WHERE integrationId = ? AND enabled = 1 ORDER BY position.
  KEY `idx_integration_destinations_integration` (`integrationId`, `enabled`, `position`),
  -- Reverse lookup for destination cleanup (e.g. "which integrations point at this tw?").
  KEY `idx_integration_destinations_target_website` (`targetWebsiteId`),

  CONSTRAINT `fk_integration_destinations_integration`
    FOREIGN KEY (`integrationId`) REFERENCES `integrations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_integration_destinations_target_website`
    FOREIGN KEY (`targetWebsiteId`) REFERENCES `target_websites` (`id`) ON DELETE CASCADE
);

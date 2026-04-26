-- Migration 0063 — Add Make-style action schemas to app_actions
--
-- These JSON columns store schema/metadata for rendering + validating actions
-- without hardcoding per-app forms in the backend.

--> statement-breakpoint
ALTER TABLE `app_actions`
  ADD COLUMN `schemaVersion` INT NOT NULL DEFAULT 1,
  ADD COLUMN `inputSchema` JSON NULL,
  ADD COLUMN `outputSchema` JSON NULL,
  ADD COLUMN `uiSchema` JSON NULL;


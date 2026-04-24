-- Migration 0052 — Enforce `target_websites.appKey` NOT NULL (phased, online-friendly)
--
-- PREREQ — verify (must be 0 or migration will fail on MODIFY):
--   SELECT COUNT(*) AS remaining_null FROM `target_websites` WHERE `appKey` IS NULL;
-- IF remaining_null > 0 → apply 0051 (or run its UPDATEs) and re-verify. DO NOT run below.
--
-- STRATEGY
--   1) Add NOT NULL with DEFAULT 'unknown' so existing rows (already backfilled) stay valid
--      and brief locks only apply; new rows without appKey get a sentinel until app code ships.
--   2) Remove DEFAULT so new inserts must supply `appKey` (application enforces after deploy).
--
-- ROLLBACK (schema only):
--   ALTER TABLE `target_websites` MODIFY COLUMN `appKey` VARCHAR(64) NULL;
-- (No row data loss.)

--> statement-breakpoint
ALTER TABLE `target_websites`
  MODIFY COLUMN `appKey` VARCHAR(64) NOT NULL DEFAULT 'unknown';

--> statement-breakpoint
ALTER TABLE `target_websites`
  MODIFY COLUMN `appKey` VARCHAR(64) NOT NULL;

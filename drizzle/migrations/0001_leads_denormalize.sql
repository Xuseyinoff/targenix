-- Migration: 0001_leads_denormalize
-- Adds denormalized columns to `leads` for single-query reads and analytics.
-- All new columns are nullable — safe to run against existing data.
-- Run backfill-leads.ts after this migration to populate historical rows.

-- Step 1: Add new columns using ALGORITHM=INSTANT (MySQL 8.0+)
-- Does NOT rewrite the table — zero disk space needed, near-instant execution.
-- AFTER clauses are not supported with INSTANT, columns go to the end (no functional difference).
ALTER TABLE `leads`
  ADD COLUMN `pageName`     VARCHAR(255)  NULL,
  ADD COLUMN `formName`     VARCHAR(255)  NULL,
  ADD COLUMN `campaignId`   VARCHAR(100)  NULL,
  ADD COLUMN `campaignName` VARCHAR(255)  NULL,
  ADD COLUMN `adsetId`      VARCHAR(100)  NULL,
  ADD COLUMN `adsetName`    VARCHAR(255)  NULL,
  ADD COLUMN `adId`         VARCHAR(100)  NULL,
  ADD COLUMN `adName`       VARCHAR(255)  NULL,
  ADD COLUMN `extraFields`  JSON          NULL,
  ALGORITHM=INSTANT;

-- Step 2: Add indexes (these do require some I/O but no full table copy)
ALTER TABLE `leads`
  ADD INDEX `idx_leads_user_platform_created_at` (`userId`, `platform`, `createdAt`);

ALTER TABLE `leads`
  ADD INDEX `idx_leads_user_form_id` (`userId`, `formId`);

ALTER TABLE `leads`
  ADD INDEX `idx_leads_user_campaign_id` (`userId`, `campaignId`);

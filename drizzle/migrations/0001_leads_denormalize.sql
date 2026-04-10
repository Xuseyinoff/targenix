-- Migration: 0001_leads_denormalize
-- Adds denormalized columns to `leads` for single-query reads and analytics.
-- All new columns are nullable — safe to run against existing data.
-- Run backfill-leads.ts after this migration to populate historical rows.

ALTER TABLE `leads`
  -- Denormalized source info (from facebook_forms)
  ADD COLUMN `pageName`     VARCHAR(255)  NULL AFTER `platform`,
  ADD COLUMN `formName`     VARCHAR(255)  NULL AFTER `pageName`,

  -- Ad attribution (from Graph API)
  ADD COLUMN `campaignId`   VARCHAR(100)  NULL AFTER `formName`,
  ADD COLUMN `campaignName` VARCHAR(255)  NULL AFTER `campaignId`,
  ADD COLUMN `adsetId`      VARCHAR(100)  NULL AFTER `campaignName`,
  ADD COLUMN `adsetName`    VARCHAR(255)  NULL AFTER `adsetId`,
  ADD COLUMN `adId`         VARCHAR(100)  NULL AFTER `adsetName`,
  ADD COLUMN `adName`       VARCHAR(255)  NULL AFTER `adId`,

  -- Remaining field_data (email, city, custom)
  ADD COLUMN `extraFields`  JSON          NULL AFTER `adName`,

  -- New indexes
  ADD INDEX `idx_leads_user_platform_created_at` (`userId`, `platform`, `createdAt`),
  ADD INDEX `idx_leads_user_form_id`             (`userId`, `formId`),
  ADD INDEX `idx_leads_user_campaign_id`         (`userId`, `campaignId`);

-- Add dedicated facebookAccountId column to integrations for efficient disconnect cleanup.
-- Previously, facebookAccountId was buried in the config JSON (no index, two key names).
-- Now: dedicated nullable INT column + index → fast lookup on disconnect.
-- Existing rows backfilled separately via tooling/mysql/backfill-integration-fb-account-id.mjs.

ALTER TABLE integrations
  ADD COLUMN facebookAccountId INT NULL AFTER targetWebsiteId,
  ADD INDEX idx_integrations_fb_account_id (facebookAccountId);

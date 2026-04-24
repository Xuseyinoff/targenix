-- Migration 0050 — Register Telegram + Google Sheets in `apps` / `app_actions` (DB-driven catalogue)
--
-- PURPOSE (additive, dual-mode):
--   • Seed first-party integrations that are not in `connection_app_specs` / 0046.
--   • Keeps `listAppsSafe` + admin/connection pickers consistent when `apps` is the source.
--   • Optional: backfill `target_websites.appKey` from `templateType` for legacy rows (no delivery change:
--     `resolveAdapterKey` already falls back to `templateType` when `appKey` is null).
--
-- ROLLBACK (application may still reference keys; apply only before prod dependency):
--   DELETE FROM `app_actions` WHERE `appKey` IN ('telegram','google-sheets') AND `actionKey` IN ('send_message','append_row');
--   DELETE FROM `apps` WHERE `appKey` IN ('telegram','google-sheets');
--   (optionally revert backfill): UPDATE `target_websites` SET `appKey` = NULL WHERE …

--> statement-breakpoint
-- ═══ apps ═══════════════════════════════════════════════════════════════════
INSERT INTO `apps` (
  `appKey`,
  `displayName`,
  `category`,
  `authType`,
  `fields`,
  `oauthConfig`,
  `iconUrl`,
  `docsUrl`,
  `isActive`
) VALUES
(
  'telegram',
  'Telegram',
  'messaging',
  'api_key',
  CAST('[{"key":"bot_token","label":"Bot Token","required":true,"sensitive":true}]' AS JSON),
  NULL,
  NULL,
  NULL,
  TRUE
),
(
  'google-sheets',
  'Google Sheets',
  'data',
  'oauth2',
  CAST('[]' AS JSON),
  NULL,
  NULL,
  NULL,
  TRUE
)
ON DUPLICATE KEY UPDATE
  `displayName` = VALUES(`displayName`),
  `category` = VALUES(`category`),
  `authType` = VALUES(`authType`),
  `fields` = VALUES(`fields`),
  `isActive` = VALUES(`isActive`);

--> statement-breakpoint
-- ═══ app_actions (schema: 0048 — no `config` column; empty JSON arrays + placeholder URL) ═══
INSERT INTO `app_actions` (
  `appKey`,
  `actionKey`,
  `name`,
  `endpointUrl`,
  `method`,
  `contentType`,
  `bodyFields`,
  `userFields`,
  `variableFields`,
  `autoMappedFields`,
  `isDefault`,
  `isActive`
) VALUES
(
  'telegram',
  'send_message',
  'Send Message',
  '',
  'POST',
  NULL,
  CAST('[]' AS JSON),
  CAST('[]' AS JSON),
  CAST('[]' AS JSON),
  CAST('[]' AS JSON),
  TRUE,
  TRUE
),
(
  'google-sheets',
  'append_row',
  'Append Row',
  '',
  'POST',
  NULL,
  CAST('[]' AS JSON),
  CAST('[]' AS JSON),
  CAST('[]' AS JSON),
  CAST('[]' AS JSON),
  TRUE,
  TRUE
)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `endpointUrl` = VALUES(`endpointUrl`),
  `method` = VALUES(`method`),
  `isActive` = VALUES(`isActive`);

--> statement-breakpoint
-- Dual-mode: align denormalized appKey with templateType for older rows (nullable appKey after 0049).
UPDATE `target_websites`
SET `appKey` = 'telegram'
WHERE `templateType` = 'telegram'
  AND (`appKey` IS NULL OR `appKey` = '');

--> statement-breakpoint
UPDATE `target_websites`
SET `appKey` = 'google-sheets'
WHERE `templateType` = 'google-sheets'
  AND (`appKey` IS NULL OR `appKey` = '');

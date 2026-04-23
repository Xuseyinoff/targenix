-- Migration 0047: extend connection_app_specs.authType ENUM to include 'none'.
--
-- Motivation:
--   Some Uzbek affiliates accept leads over an open endpoint (no API key,
--   no OAuth, no basic auth). Stage 1 modelled auth as a closed ENUM of
--   'api_key' | 'oauth2' | 'bearer' | 'basic', which made those
--   credential-less apps unrepresentable. Admins had to either invent a
--   fake `api_key` field or misuse an existing app spec — both are
--   silent foot-guns.
--
-- Change:
--   1. Add the new literal 'none' to the existing authType ENUM on
--      connection_app_specs. Existing rows keep their current value.
--   2. No data changes. The TypeScript constant in
--      server/integrations/connectionAppSpecs.ts is updated in the same
--      commit to add 'none' to the ConnectionAuthType union.
--
-- Runtime invariants preserved:
--   • A template pinned to an authType='none' spec MUST NOT contain any
--     `{{SECRET:…}}` token and MUST NOT mark any body field as
--     `isSecret: true`. Enforced by validateTemplateContract.
--   • resolveSecretsForDelivery returns `{}` for authType='none' specs,
--     so no connection is required.
--
-- Rollback (only safe while no authType='none' rows exist):
--   DELETE FROM `connection_app_specs` WHERE `appKey` = 'open_affiliate';
--   ALTER TABLE `connection_app_specs`
--     MODIFY COLUMN `authType`
--     ENUM('api_key','oauth2','bearer','basic') NOT NULL;

--> statement-breakpoint
ALTER TABLE `connection_app_specs`
  MODIFY COLUMN `authType`
  ENUM('api_key','oauth2','bearer','basic','none') NOT NULL;
--> statement-breakpoint
INSERT INTO `connection_app_specs` (
  `appKey`, `displayName`, `authType`, `category`, `fields`, `iconUrl`
) VALUES (
  'open_affiliate',
  'Open Affiliate (no credentials)',
  'none',
  'affiliate',
  JSON_ARRAY(),
  NULL
)
ON DUPLICATE KEY UPDATE
  `displayName` = VALUES(`displayName`),
  `authType`    = VALUES(`authType`),
  `category`    = VALUES(`category`),
  `fields`      = VALUES(`fields`);

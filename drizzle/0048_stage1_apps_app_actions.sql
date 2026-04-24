-- Migration 0048 — Stage 1 foundation: `apps` + `app_actions` (mirror / parallel tables)
--
-- PURPOSE (additive only):
--   • Introduce new catalogue tables for a future DB-driven app/actions model.
--   • One-time copy from `connection_app_specs` → `apps` and
--     `destination_templates` → `app_actions`.
--   • Does NOT drop or modify existing tables; application code is unchanged
--     until a later cutover.
--
-- DESIGN NOTES
--   • `connection_app_specs` has no `isActive` / `oauthConfig` / `docsUrl` —
--     new columns use sensible defaults (all active, NULL optional JSON/URLs).
--   • `destination_templates.appKey` may be NULL for legacy/orphan rows — those
--     are NOT copied into `app_actions` (NOT NULL + FK-in-spirit later). Check
--     post-migration counts; row counts may differ if NULLs exist.
--   • UNIQUE (appKey, actionKey) cannot use actionKey = 'default' for every
--     row when multiple templates share one appKey. We set
--     actionKey = CONCAT('t', id) (stable, one row per source template id).
--
-- ROLLBACK (only before any code references these tables):
--   DROP TABLE IF EXISTS `app_actions`;
--   DROP TABLE IF EXISTS `apps`;

--> statement-breakpoint
CREATE TABLE `apps` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `appKey` VARCHAR(64) NOT NULL,
  `displayName` VARCHAR(128) NOT NULL,
  `category` VARCHAR(32) NOT NULL,
  `authType` VARCHAR(32) NOT NULL,
  `fields` JSON NOT NULL,
  `oauthConfig` JSON NULL,
  `iconUrl` VARCHAR(512) NULL,
  `docsUrl` VARCHAR(512) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_apps_appKey` (`appKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint
INSERT INTO `apps` (
  `appKey`,
  `displayName`,
  `category`,
  `authType`,
  `fields`,
  `oauthConfig`,
  `iconUrl`,
  `docsUrl`,
  `isActive`,
  `createdAt`
)
SELECT
  `appKey`,
  `displayName`,
  `category`,
  `authType` AS `authType`,
  `fields`,
  NULL,
  `iconUrl`,
  NULL,
  TRUE,
  `createdAt`
FROM `connection_app_specs`;

--> statement-breakpoint
CREATE TABLE `app_actions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `appKey` VARCHAR(64) NOT NULL,
  `actionKey` VARCHAR(64) NOT NULL DEFAULT 'default',
  `name` VARCHAR(255) NOT NULL,
  `endpointUrl` VARCHAR(500) NOT NULL,
  `method` VARCHAR(10) NOT NULL DEFAULT 'POST',
  `contentType` VARCHAR(100) NULL,
  `bodyFields` JSON NOT NULL,
  `userFields` JSON NOT NULL,
  `variableFields` JSON NOT NULL,
  `autoMappedFields` JSON NOT NULL,
  `isDefault` BOOLEAN NOT NULL DEFAULT TRUE,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_app_action` (`appKey`, `actionKey`),
  KEY `idx_app_actions_appKey` (`appKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint
-- Copy only rows with a resolvable appKey (required for the new model).
-- actionKey = 't' + id keeps UNIQUE(appKey, actionKey) valid when several
-- destination_templates point at the same appKey.
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
  `isActive`,
  `createdAt`
)
SELECT
  `appKey`,
  CONCAT('t', `id`) AS `actionKey`,
  `name`,
  `endpointUrl`,
  `method`,
  `contentType`,
  `bodyFields`,
  `userVisibleFields` AS `userFields`,
  `variableFields`,
  `autoMappedFields`,
  TRUE,
  `isActive`,
  `createdAt`
FROM `destination_templates`
WHERE `appKey` IS NOT NULL
  AND `appKey` <> '';

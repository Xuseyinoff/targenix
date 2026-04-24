-- Migration 0049 — Stage 2: `target_websites.appKey` + `actionId` (additive + backfill)
--
-- PURPOSE
--   • Denormalize `appKey` and `app_actions.id` onto `target_websites` for the
--     next-phase routing model. Nullable columns: rows without `templateId`
--     (e.g. Telegram, Sheets) are left NULL — delivery unchanged.
--
-- BACKFILL (actionId)
--   0048 sets `isDefault = 1` on every `app_actions` row, so
--   `JOIN ... AND aa.isDefault = 1` is NOT unique per app. We key actions to
--   templates the same way as migration 0048: `actionKey = CONCAT('t', dt.id)`.
--
-- ROLLBACK (before application code depends on these columns)
--   ALTER TABLE `target_websites` DROP COLUMN `appKey`, DROP COLUMN `actionId`;

--> statement-breakpoint
ALTER TABLE `target_websites`
  ADD COLUMN `appKey` VARCHAR(64) NULL,
  ADD COLUMN `actionId` INT NULL;

--> statement-breakpoint
UPDATE `target_websites` `tw`
INNER JOIN `destination_templates` `dt` ON `dt`.`id` = `tw`.`templateId`
SET `tw`.`appKey` = `dt`.`appKey`
WHERE `tw`.`appKey` IS NULL;

--> statement-breakpoint
-- MySQL 8+ mixed default collations (unicode_ci vs 0900_ai_ci) on varchar joins — use
-- BINARY for `appKey` (ASCII app identifiers) and explicit collation for `actionKey`.
UPDATE `target_websites` `tw`
INNER JOIN `destination_templates` `dt` ON `dt`.`id` = `tw`.`templateId`
INNER JOIN `app_actions` `aa`
  ON BINARY `aa`.`appKey` = BINARY `dt`.`appKey`
  AND `aa`.`actionKey` = CONVERT(CONCAT('t', `dt`.`id`) USING utf8mb4) COLLATE utf8mb4_unicode_ci
SET `tw`.`actionId` = `aa`.`id`
WHERE `tw`.`actionId` IS NULL;

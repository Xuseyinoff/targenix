-- Migration 0051 — Backfill `target_websites.appKey` (safe, NULL only — no overwrites)
--
-- PREREQ (read-only, run in prod/staging before this migration):
--   SELECT
--     COUNT(*) AS total,
--     SUM(`appKey` IS NULL) AS null_appkey,
--     SUM(`templateType` = 'telegram' AND `appKey` IS NULL) AS telegram_missing,
--     SUM(`templateType` = 'google-sheets' AND `appKey` IS NULL) AS sheets_missing,
--     SUM(`templateId` IS NOT NULL AND `appKey` IS NULL) AS template_missing
--   FROM `target_websites`;
--
-- IF `null_appkey` = 0 you may skip 0051 UPDATEs; still need 0052 for NOT NULL.
--
-- ROLLBACK (data): re-run only if you restore from backup — these UPDATEs are not trivially reversed.
-- Application treats `appKey` = 'unknown' as legacy mode (see resolveAdapterKey).

--> statement-breakpoint
-- 2.1 Telegram
UPDATE `target_websites`
SET `appKey` = 'telegram'
WHERE `appKey` IS NULL
  AND `templateType` = 'telegram';

--> statement-breakpoint
-- 2.2 Google Sheets (both spellings seen in the wild)
UPDATE `target_websites`
SET `appKey` = 'google-sheets'
WHERE `appKey` IS NULL
  AND `templateType` IN ('google-sheets', 'google_sheets');

--> statement-breakpoint
-- 2.3 Affiliate (template-based) — only copy when template has a non-empty appKey
UPDATE `target_websites` `tw`
INNER JOIN `destination_templates` `dt` ON `dt`.`id` = `tw`.`templateId`
SET `tw`.`appKey` = `dt`.`appKey`
WHERE `tw`.`appKey` IS NULL
  AND `tw`.`templateId` IS NOT NULL
  AND `dt`.`appKey` IS NOT NULL
  AND TRIM(`dt`.`appKey`) <> '';

--> statement-breakpoint
-- 2.4 Last resort — any remaining NULL (legacy custom, orphan rows, etc.)
UPDATE `target_websites`
SET `appKey` = 'unknown'
WHERE `appKey` IS NULL;

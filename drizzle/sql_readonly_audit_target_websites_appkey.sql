-- Read-only audit — run before / after 0051 + before 0052 (no writes).
-- Paste results into deploy notes.

SELECT
  COUNT(*) AS total,
  SUM(`appKey` IS NULL) AS null_appkey,
  SUM(`templateType` = 'telegram' AND `appKey` IS NULL) AS telegram_missing,
  SUM(`templateType` = 'google-sheets' AND `appKey` IS NULL) AS sheets_missing,
  SUM(`templateId` IS NOT NULL AND `appKey` IS NULL) AS template_missing
FROM `target_websites`;

-- Must be 0 before applying 0052:
SELECT COUNT(*) AS remaining_null FROM `target_websites` WHERE `appKey` IS NULL;

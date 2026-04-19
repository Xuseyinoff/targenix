-- Allow telegram destinations (no URL needed for bot delivery).
-- Count non-null url rows with empty/null before running if needed.
ALTER TABLE `target_websites` MODIFY COLUMN `url` text NULL;

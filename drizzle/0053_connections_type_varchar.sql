-- Migration 0053 — `connections.type` ENUM → VARCHAR(32) NOT NULL
--
-- PURPOSE
--   • Allow future connection types without ALTER ENUM each time.
--   • Existing string values are preserved byte-for-byte (MySQL-safe widen).
--
-- PREREQ (read-only, run before apply):
--   SELECT `type`, COUNT(*) AS c FROM `connections` GROUP BY `type`;
--   Expect only: google_sheets | telegram_bot | api_key
--
-- ROLLBACK (schema only — restores ENUM):
--   ALTER TABLE `connections`
--     MODIFY COLUMN `type` ENUM('google_sheets','telegram_bot','api_key') NOT NULL;

--> statement-breakpoint
ALTER TABLE `connections`
  MODIFY COLUMN `type` VARCHAR(32) NOT NULL;

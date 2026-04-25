-- Migration 0062 — Drop legacy google_accounts table (after universal OAuth migration)
--
-- Preconditions (must all be true):
--   1) No runtime/tooling dependency remains (repo grep has no SQL touching google_accounts)
--   2) connections.googleAccountId column is already dropped
--   3) Backup taken (see tooling/mysql/backup-google-accounts.mjs)
--   4) No FKs reference google_accounts:
--      SELECT * FROM information_schema.KEY_COLUMN_USAGE
--       WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='google_accounts';

--> statement-breakpoint
DROP TABLE `google_accounts`;


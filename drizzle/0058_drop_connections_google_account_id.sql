-- Migration 0058 — Drop legacy connections.googleAccountId (oauthTokenId is source of truth)
--
-- Preconditions (verified in prod before applying):
--   SELECT COUNT(*) FROM connections WHERE googleAccountId IS NOT NULL;                       -- must be 0
--   SELECT COUNT(*) FROM connections WHERE googleAccountId IS NOT NULL AND oauthTokenId IS NULL; -- must be 0
--
-- Rollback:
--   See 0059_restore_connections_google_account_id.sql

--> statement-breakpoint
ALTER TABLE `connections` DROP FOREIGN KEY `fk_connections_google_account`;

--> statement-breakpoint
ALTER TABLE `connections` DROP INDEX `fk_connections_google_account`;

--> statement-breakpoint
ALTER TABLE `connections` DROP COLUMN `googleAccountId`;


-- Migration 0060 — Final removal of legacy connections.googleAccountId
--
-- This exists because 0058 was accidentally rolled back by a now-removed
-- migration file. This migration ensures the prod schema matches code.
--
-- Preconditions (safe to run):
--   SELECT COUNT(*) FROM connections WHERE googleAccountId IS NOT NULL;                          -- must be 0
--   SELECT COUNT(*) FROM connections WHERE googleAccountId IS NOT NULL AND oauthTokenId IS NULL; -- must be 0
--
-- Manual rollback (if absolutely needed):
--   ALTER TABLE connections ADD COLUMN googleAccountId INT NULL;
--   ALTER TABLE connections ADD KEY fk_connections_google_account (googleAccountId);
--   ALTER TABLE connections
--     ADD CONSTRAINT fk_connections_google_account
--     FOREIGN KEY (googleAccountId) REFERENCES google_accounts(id) ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE `connections` DROP FOREIGN KEY `fk_connections_google_account`;

--> statement-breakpoint
ALTER TABLE `connections` DROP INDEX `fk_connections_google_account`;

--> statement-breakpoint
ALTER TABLE `connections` DROP COLUMN `googleAccountId`;


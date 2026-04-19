-- Separate Google Login tokens from Google Integration tokens.
-- Same Google email can now appear twice per user: once as 'login', once as 'integration'.
-- Integration accounts carry full Sheets/Drive scopes; login accounts carry only email+profile.

ALTER TABLE `google_accounts`
  ADD COLUMN `type` ENUM('login','integration') NOT NULL DEFAULT 'login' AFTER `expiryDate`,
  ADD COLUMN `scopes` TEXT AFTER `type`,
  DROP INDEX `uq_google_accounts_user_email`,
  ADD UNIQUE KEY `uq_google_accounts_user_email_type` (`userId`, `email`, `type`),
  ADD KEY `idx_google_accounts_type` (`userId`, `type`);
--> statement-breakpoint
ALTER TABLE `google_oauth_states`
  ADD COLUMN `type` ENUM('login','integration') NOT NULL DEFAULT 'login' AFTER `userId`;

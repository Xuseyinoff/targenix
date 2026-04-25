-- Migration 0055 — Universal OAuth: oauth_states, oauth_tokens, connections.oauthTokenId
-- Backfill from google_accounts (integration) for existing users.

--> statement-breakpoint
CREATE TABLE `oauth_states` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `state` VARCHAR(128) NOT NULL,
  `userId` INT NOT NULL,
  `provider` VARCHAR(32) NOT NULL,
  `mode` VARCHAR(32) NOT NULL,
  `appKey` VARCHAR(64) NULL,
  `expiresAt` TIMESTAMP NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_oauth_states_state` (`state`),
  KEY `idx_oauth_states_user` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `appKey` VARCHAR(64) NOT NULL,
  `email` VARCHAR(320) NOT NULL,
  `name` VARCHAR(255) NULL,
  `picture` VARCHAR(512) NULL,
  `accessToken` TEXT NOT NULL,
  `refreshToken` TEXT NULL,
  `expiryDate` TIMESTAMP NULL,
  `scopes` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_oauth_tokens_user_app_email` (`userId`, `appKey`, `email`),
  KEY `idx_oauth_tokens_user_app` (`userId`, `appKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint
ALTER TABLE `connections` ADD COLUMN `oauthTokenId` INT NULL;

--> statement-breakpoint
ALTER TABLE `connections` ADD KEY `idx_connections_oauth_token_id` (`oauthTokenId`);

--> statement-breakpoint
-- Backfill oauth_tokens from existing Google integration accounts
-- Preserve the same `id` as the source `google_accounts` row so existing
-- templateConfig / UI references to googleAccountId continue to point at this row.
INSERT INTO `oauth_tokens` (
  `id`, `userId`, `appKey`, `email`, `name`, `picture`, `accessToken`, `refreshToken`, `expiryDate`, `scopes`, `createdAt`
)
SELECT
  `id`,
  `userId`,
  'google-sheets' AS `appKey`,
  `email`,
  `name`,
  `picture`,
  `accessToken`,
  `refreshToken`,
  `expiryDate`,
  `scopes`,
  `connectedAt`
FROM `google_accounts`
WHERE `type` = 'integration';

--> statement-breakpoint
UPDATE `connections` `c`
INNER JOIN `google_accounts` `g` ON `c`.`googleAccountId` = `g`.`id` AND `g`.`type` = 'integration'
INNER JOIN `oauth_tokens` `t`
  ON `t`.`userId` = `g`.`userId`
  AND `t`.`appKey` = 'google-sheets'
  AND BINARY `t`.`email` = BINARY `g`.`email`
SET `c`.`oauthTokenId` = `t`.`id`
WHERE `c`.`type` = 'google_sheets' AND `c`.`oauthTokenId` IS NULL;

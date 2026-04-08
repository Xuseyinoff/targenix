ALTER TABLE `facebook_accounts` DROP INDEX `facebook_accounts_fbUserId_unique`;--> statement-breakpoint
ALTER TABLE `facebook_connections` DROP INDEX `facebook_connections_pageId_unique`;--> statement-breakpoint
ALTER TABLE `facebook_accounts` ADD CONSTRAINT `uq_facebook_accounts_user_fbuser` UNIQUE(`userId`,`fbUserId`);--> statement-breakpoint
ALTER TABLE `facebook_connections` ADD CONSTRAINT `uq_facebook_connections_user_page` UNIQUE(`userId`,`pageId`);
CREATE TABLE `facebook_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`fbUserId` varchar(64) NOT NULL,
	`fbUserName` varchar(255) NOT NULL,
	`accessToken` text NOT NULL,
	`tokenExpiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `facebook_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `facebook_accounts_fbUserId_unique` UNIQUE(`fbUserId`)
);
--> statement-breakpoint
CREATE TABLE `target_websites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`url` text NOT NULL,
	`headers` json,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `target_websites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `integrations` MODIFY COLUMN `type` enum('TELEGRAM','AFFILIATE','LEAD_ROUTING') NOT NULL;
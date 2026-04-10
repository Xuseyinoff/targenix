CREATE TABLE `ad_accounts_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`facebookAccountId` int NOT NULL,
	`fbAdAccountId` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'UNKNOWN',
	`statusCode` int NOT NULL DEFAULT 0,
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`timezone` varchar(64),
	`balance` varchar(32) NOT NULL DEFAULT '0',
	`amountSpent` varchar(32) NOT NULL DEFAULT '0',
	`minDailyBudget` varchar(32) NOT NULL DEFAULT '0',
	`lastSyncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ad_accounts_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ad_accounts_cache_user_account` UNIQUE(`userId`,`fbAdAccountId`)
);
--> statement-breakpoint
CREATE TABLE `ad_sets_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`facebookAccountId` int NOT NULL,
	`fbAdAccountId` varchar(64) NOT NULL,
	`fbCampaignId` varchar(64) NOT NULL,
	`fbAdSetId` varchar(64) NOT NULL,
	`name` varchar(512) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'ACTIVE',
	`dailyBudget` varchar(32) NOT NULL DEFAULT '0',
	`lifetimeBudget` varchar(32) NOT NULL DEFAULT '0',
	`optimizationGoal` varchar(64),
	`billingEvent` varchar(64),
	`lastSyncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ad_sets_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ad_sets_cache_user_adset` UNIQUE(`userId`,`fbAdSetId`)
);
--> statement-breakpoint
CREATE TABLE `campaign_insights_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`facebookAccountId` int NOT NULL,
	`fbAdAccountId` varchar(64) NOT NULL,
	`fbCampaignId` varchar(64) NOT NULL,
	`datePreset` varchar(32) NOT NULL,
	`spend` varchar(32) NOT NULL DEFAULT '0',
	`impressions` int NOT NULL DEFAULT 0,
	`clicks` int NOT NULL DEFAULT 0,
	`leads` int NOT NULL DEFAULT 0,
	`ctr` varchar(16) NOT NULL DEFAULT '0',
	`cpl` varchar(16) NOT NULL DEFAULT '0',
	`conversionRate` varchar(16) NOT NULL DEFAULT '0',
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `campaign_insights_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_campaign_insights_cache_key` UNIQUE(`userId`,`fbCampaignId`,`datePreset`)
);
--> statement-breakpoint
CREATE TABLE `campaigns_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`facebookAccountId` int NOT NULL,
	`fbAdAccountId` varchar(64) NOT NULL,
	`fbCampaignId` varchar(64) NOT NULL,
	`name` varchar(512) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'ACTIVE',
	`objective` varchar(64) NOT NULL DEFAULT '',
	`dailyBudget` varchar(32) NOT NULL DEFAULT '0',
	`lifetimeBudget` varchar(32) NOT NULL DEFAULT '0',
	`lastSyncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `campaigns_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_campaigns_cache_user_campaign` UNIQUE(`userId`,`fbCampaignId`)
);
--> statement-breakpoint
CREATE INDEX `idx_ad_accounts_cache_fb_account` ON `ad_accounts_cache` (`facebookAccountId`);--> statement-breakpoint
CREATE INDEX `idx_ad_sets_cache_user_campaign` ON `ad_sets_cache` (`userId`,`fbCampaignId`);--> statement-breakpoint
CREATE INDEX `idx_campaign_insights_cache_account` ON `campaign_insights_cache` (`userId`,`fbAdAccountId`);--> statement-breakpoint
CREATE INDEX `idx_campaigns_cache_user_ad_account` ON `campaigns_cache` (`userId`,`fbAdAccountId`);
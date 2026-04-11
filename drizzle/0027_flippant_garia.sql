CREATE TABLE `destination_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` varchar(500),
	`color` varchar(7) NOT NULL DEFAULT '#3B82F6',
	`endpointUrl` varchar(500) NOT NULL,
	`method` varchar(10) NOT NULL DEFAULT 'POST',
	`contentType` varchar(100) NOT NULL DEFAULT 'application/x-www-form-urlencoded',
	`bodyFields` json NOT NULL,
	`userVisibleFields` json NOT NULL,
	`variableFields` json NOT NULL,
	`autoMappedFields` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `destination_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `leads` ADD `pageName` varchar(255);--> statement-breakpoint
ALTER TABLE `leads` ADD `formName` varchar(255);--> statement-breakpoint
ALTER TABLE `leads` ADD `campaignId` varchar(100);--> statement-breakpoint
ALTER TABLE `leads` ADD `campaignName` varchar(255);--> statement-breakpoint
ALTER TABLE `leads` ADD `adsetId` varchar(100);--> statement-breakpoint
ALTER TABLE `leads` ADD `adsetName` varchar(255);--> statement-breakpoint
ALTER TABLE `leads` ADD `adId` varchar(100);--> statement-breakpoint
ALTER TABLE `leads` ADD `adName` varchar(255);--> statement-breakpoint
ALTER TABLE `leads` ADD `extraFields` json;--> statement-breakpoint
ALTER TABLE `target_websites` ADD `templateId` int;--> statement-breakpoint
CREATE INDEX `idx_leads_user_platform_created_at` ON `leads` (`userId`,`platform`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_form_id` ON `leads` (`userId`,`formId`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_campaign_id` ON `leads` (`userId`,`campaignId`);
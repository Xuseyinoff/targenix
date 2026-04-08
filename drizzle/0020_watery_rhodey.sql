ALTER TABLE `integrations` ADD `targetWebsiteId` int;--> statement-breakpoint
CREATE INDEX `idx_integrations_target_website_id` ON `integrations` (`targetWebsiteId`);
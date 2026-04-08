DROP INDEX `idx_integrations_user_active` ON `integrations`;--> statement-breakpoint
ALTER TABLE `integrations` ADD `pageId` varchar(128);--> statement-breakpoint
ALTER TABLE `integrations` ADD `formId` varchar(128);--> statement-breakpoint
CREATE INDEX `idx_integrations_user_page_form` ON `integrations` (`userId`,`isActive`,`pageId`,`formId`);
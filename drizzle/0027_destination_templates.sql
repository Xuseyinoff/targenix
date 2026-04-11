-- Admin-managed destination templates table
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
-- Add templateId FK column to target_websites (nullable — null for legacy custom/sotuvchi/100k)
ALTER TABLE `target_websites` ADD COLUMN `templateId` int;

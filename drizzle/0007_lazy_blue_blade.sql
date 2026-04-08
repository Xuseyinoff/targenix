ALTER TABLE `target_websites` ADD `templateType` varchar(32) DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `target_websites` ADD `templateConfig` json;
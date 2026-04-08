ALTER TABLE `facebook_accounts` ADD `connectedAt` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `facebook_connections` ADD `subscriptionStatus` enum('active','failed','inactive') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `facebook_connections` ADD `subscriptionError` text;
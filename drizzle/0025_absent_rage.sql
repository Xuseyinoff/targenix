CREATE TABLE `password_reset_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`token` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `password_reset_tokens_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
DROP INDEX `idx_app_logs_log_type` ON `app_logs`;--> statement-breakpoint
DROP INDEX `idx_app_logs_event_type` ON `app_logs`;--> statement-breakpoint
CREATE INDEX `idx_app_logs_log_type_created_at` ON `app_logs` (`logType`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_app_logs_event_type_created_at` ON `app_logs` (`eventType`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_app_logs_level_created_at` ON `app_logs` (`level`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_created_at` ON `leads` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_page_status` ON `leads` (`userId`,`pageId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_leads_created_at` ON `leads` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_orders_integration_status` ON `orders` (`integrationId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_orders_created_at` ON `orders` (`createdAt`);
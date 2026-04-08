ALTER TABLE `app_logs` ADD `logType` enum('USER','SYSTEM') DEFAULT 'SYSTEM' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_logs` ADD `eventType` varchar(64);--> statement-breakpoint
ALTER TABLE `app_logs` ADD `source` varchar(64);--> statement-breakpoint
ALTER TABLE `app_logs` ADD `duration` int;--> statement-breakpoint
CREATE INDEX `idx_app_logs_log_type` ON `app_logs` (`logType`);--> statement-breakpoint
CREATE INDEX `idx_app_logs_event_type` ON `app_logs` (`eventType`);--> statement-breakpoint
CREATE INDEX `idx_app_logs_created_at` ON `app_logs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_status` ON `leads` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_created_at` ON `webhook_events` (`createdAt`);
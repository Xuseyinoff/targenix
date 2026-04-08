ALTER TABLE `app_logs` ADD `userId` int;--> statement-breakpoint
CREATE INDEX `idx_app_logs_user_created_at` ON `app_logs` (`userId`,`createdAt`);
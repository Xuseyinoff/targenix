ALTER TABLE `orders` ADD `attempts` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `orders` ADD `lastAttemptAt` timestamp;
--> statement-breakpoint
ALTER TABLE `orders` ADD `nextRetryAt` timestamp;
--> statement-breakpoint
UPDATE `orders` SET `attempts` = `retryCount`;
--> statement-breakpoint
ALTER TABLE `orders` DROP COLUMN `retryCount`;
--> statement-breakpoint
CREATE INDEX `idx_orders_retry_due` ON `orders` (`status`, `nextRetryAt`);

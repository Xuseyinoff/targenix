ALTER TABLE `integrations` ADD `telegramChatId` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `telegramChatId` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `telegramUsername` varchar(128);--> statement-breakpoint
ALTER TABLE `users` ADD `telegramConnectedAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `telegramConnectToken` varchar(128);
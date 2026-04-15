-- Telegram destinations delivery mode (AUTO vs MANUAL)
-- Store user preference and default delivery chat for destinations/templates mapping.

ALTER TABLE `users`
  ADD COLUMN `telegramDestinationDeliveryMode` varchar(16) NOT NULL DEFAULT 'MANUAL' AFTER `telegramConnectToken`,
  ADD COLUMN `telegramDestinationDefaultChatId` varchar(64) NULL AFTER `telegramDestinationDeliveryMode`,
  ADD INDEX `idx_users_telegram_destination_mode` (`telegramDestinationDeliveryMode`);

-- Add telegramChatId mapping to destinations (target_websites)

ALTER TABLE `target_websites`
  ADD COLUMN `telegramChatId` varchar(64);

CREATE INDEX `idx_target_websites_user_telegram_chat` ON `target_websites` (`userId`, `telegramChatId`);
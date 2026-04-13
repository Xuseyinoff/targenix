-- Telegram delivery chats (SaaS-safe)

ALTER TABLE `users`
  ADD COLUMN `telegramUserId` varchar(32);

CREATE TABLE `telegram_chats` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `chatId` varchar(64) NOT NULL,
  `type` enum('SYSTEM','DELIVERY') NOT NULL,
  `title` varchar(255),
  `username` varchar(128),
  `connectedAt` timestamp NOT NULL DEFAULT (now()),
  `disconnectedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_telegram_chats_chat_id` (`chatId`),
  KEY `idx_telegram_chats_user_type` (`userId`,`type`)
);

CREATE TABLE `telegram_chat_connect_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `token` varchar(128) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `usedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_telegram_chat_connect_tokens_token` (`token`),
  KEY `idx_telegram_chat_connect_tokens_user` (`userId`,`createdAt`)
);

CREATE TABLE `telegram_chat_integrations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `telegramChatId` int NOT NULL,
  `integrationId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_telegram_chat_integrations_chat_integration` (`telegramChatId`,`integrationId`),
  KEY `idx_telegram_chat_integrations_integration` (`integrationId`)
);
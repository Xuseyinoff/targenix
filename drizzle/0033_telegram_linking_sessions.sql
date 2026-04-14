CREATE TABLE `telegram_linking_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`telegramUserId` varchar(32) NOT NULL,
	`token` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telegram_linking_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_telegram_linking_sessions_token` UNIQUE(`token`),
	KEY `idx_telegram_linking_sessions_user_expires` (`userId`, `expiresAt`),
	KEY `idx_telegram_linking_sessions_tguser_expires` (`telegramUserId`, `expiresAt`)
);

--> statement-breakpoint

CREATE TABLE `telegram_linking_session_chats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`chatId` varchar(64) NOT NULL,
	`chatType` varchar(32) NOT NULL,
	`title` varchar(255),
	`username` varchar(128),
	`botStatus` varchar(32),
	`addedByTelegramUserId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telegram_linking_session_chats_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_telegram_linking_session_chats_session_chat` UNIQUE(`sessionId`, `chatId`),
	KEY `idx_telegram_linking_session_chats_session` (`sessionId`, `createdAt`)
);
CREATE TABLE `telegram_pending_chats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`chatId` varchar(64) NOT NULL,
	`chatType` varchar(32) NOT NULL,
	`title` varchar(255),
	`username` varchar(128),
	`botStatus` varchar(32),
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
	CONSTRAINT `telegram_pending_chats_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_telegram_pending_chats_chat_id` UNIQUE(`chatId`),
	KEY `idx_telegram_pending_chats_last_seen` (`lastSeenAt`)
);
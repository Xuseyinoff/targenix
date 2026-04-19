CREATE TABLE `google_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`name` varchar(255),
	`picture` varchar(512),
	`accessToken` text NOT NULL,
	`refreshToken` text,
	`expiryDate` timestamp,
	`connectedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
	CONSTRAINT `google_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_google_accounts_user_email` UNIQUE(`userId`, `email`),
	KEY `idx_google_accounts_user_id` (`userId`)
);
--> statement-breakpoint
CREATE TABLE `google_oauth_states` (
	`id` int AUTO_INCREMENT NOT NULL,
	`state` varchar(128) NOT NULL,
	`userId` int NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `google_oauth_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_google_oauth_states_state` UNIQUE(`state`),
	KEY `idx_google_oauth_states_user_id` (`userId`)
);

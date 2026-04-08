CREATE TABLE `facebook_oauth_states` (
	`id` int AUTO_INCREMENT NOT NULL,
	`state` varchar(128) NOT NULL,
	`userId` int NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `facebook_oauth_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `facebook_oauth_states_state_unique` UNIQUE(`state`),
	CONSTRAINT `uq_facebook_oauth_states_state` UNIQUE(`state`)
);
--> statement-breakpoint
CREATE INDEX `idx_facebook_oauth_states_user_id` ON `facebook_oauth_states` (`userId`);
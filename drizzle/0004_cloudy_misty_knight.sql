CREATE TABLE `app_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`level` enum('INFO','WARN','ERROR','DEBUG') NOT NULL DEFAULT 'INFO',
	`category` varchar(64) NOT NULL,
	`message` text NOT NULL,
	`meta` json,
	`leadId` int,
	`pageId` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `app_logs_id` PRIMARY KEY(`id`)
);

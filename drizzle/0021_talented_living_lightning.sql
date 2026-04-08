CREATE TABLE `facebook_forms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`pageId` varchar(128) NOT NULL,
	`pageName` varchar(255) NOT NULL,
	`formId` varchar(128) NOT NULL,
	`formName` varchar(255) NOT NULL,
	`platform` enum('fb','ig') NOT NULL DEFAULT 'fb',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `facebook_forms_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_facebook_forms_user_page_form` UNIQUE(`userId`,`pageId`,`formId`)
);
--> statement-breakpoint
CREATE INDEX `idx_facebook_forms_user_page_form` ON `facebook_forms` (`userId`,`pageId`,`formId`);
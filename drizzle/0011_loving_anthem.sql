ALTER TABLE `leads` DROP INDEX `leads_leadgenId_unique`;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `uq_leads_leadgen_user` UNIQUE(`leadgenId`,`userId`);
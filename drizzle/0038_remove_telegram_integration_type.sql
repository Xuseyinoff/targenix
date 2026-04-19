-- Remove deprecated TELEGRAM integration type from enum.
-- Count verified = 0 before running: SELECT COUNT(*) FROM integrations WHERE type = 'TELEGRAM';
ALTER TABLE `integrations` MODIFY COLUMN `type` enum('AFFILIATE','LEAD_ROUTING') NOT NULL;

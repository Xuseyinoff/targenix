-- Destination template product category (UI / routing metadata only).
-- Existing rows receive DEFAULT 'affiliate' — no delivery pipeline change.

ALTER TABLE `destination_templates`
  ADD COLUMN `category` ENUM('messaging', 'data', 'webhooks', 'affiliate', 'crm') NOT NULL DEFAULT 'affiliate';

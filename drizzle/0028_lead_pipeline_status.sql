ALTER TABLE `leads` ADD `dataStatus` enum('PENDING','ENRICHED','ERROR') NOT NULL DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE `leads` ADD `deliveryStatus` enum('PENDING','PROCESSING','SUCCESS','FAILED','PARTIAL') NOT NULL DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE `leads` ADD `dataError` text;--> statement-breakpoint
UPDATE `leads` SET `dataStatus` = CASE `status` WHEN 'PENDING' THEN 'PENDING' WHEN 'RECEIVED' THEN 'ENRICHED' WHEN 'FAILED' THEN 'ENRICHED' ELSE 'PENDING' END, `deliveryStatus` = CASE `status` WHEN 'PENDING' THEN 'PENDING' WHEN 'FAILED' THEN 'FAILED' WHEN 'RECEIVED' THEN 'PENDING' ELSE 'PENDING' END;--> statement-breakpoint
UPDATE `leads` l
LEFT JOIN (
  SELECT `leadId`,
    SUM(CASE WHEN `status` = 'SENT' THEN 1 ELSE 0 END) AS c_sent,
    SUM(CASE WHEN `status` = 'FAILED' THEN 1 ELSE 0 END) AS c_failed,
    COUNT(*) AS c_total
  FROM `orders`
  GROUP BY `leadId`
) o ON o.`leadId` = l.`id`
SET l.`deliveryStatus` = CASE
  WHEN l.`status` = 'RECEIVED' AND (o.c_total IS NULL OR o.c_total = 0) THEN 'SUCCESS'
  WHEN l.`status` = 'RECEIVED' AND o.c_failed = o.c_total AND o.c_total > 0 THEN 'FAILED'
  WHEN l.`status` = 'RECEIVED' AND o.c_sent = o.c_total AND o.c_total > 0 THEN 'SUCCESS'
  WHEN l.`status` = 'RECEIVED' AND o.c_total > 0 AND o.c_sent = 0 AND o.c_failed = 0 THEN 'SUCCESS'
  WHEN l.`status` = 'RECEIVED' THEN 'PARTIAL'
  ELSE l.`deliveryStatus`
END
WHERE l.`status` = 'RECEIVED';--> statement-breakpoint
DELETE o1 FROM `orders` o1
INNER JOIN `orders` o2 ON o1.`leadId` = o2.`leadId` AND o1.`integrationId` = o2.`integrationId` AND o1.`id` > o2.`id`;--> statement-breakpoint
DROP INDEX `idx_leads_user_status` ON `leads`;--> statement-breakpoint
DROP INDEX `idx_leads_user_page_status` ON `leads`;--> statement-breakpoint
ALTER TABLE `leads` DROP COLUMN `status`;--> statement-breakpoint
CREATE INDEX `idx_leads_user_delivery_status` ON `leads` (`userId`,`deliveryStatus`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_data_status` ON `leads` (`userId`,`dataStatus`);--> statement-breakpoint
CREATE INDEX `idx_leads_user_page_delivery` ON `leads` (`userId`,`pageId`,`deliveryStatus`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_orders_lead_integration` ON `orders` (`leadId`,`integrationId`);

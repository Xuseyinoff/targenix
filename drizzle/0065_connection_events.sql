-- Migration 0065 — Connection lifecycle audit log
--
-- Sprint 2 / Item 2.4: every connection state change (create, rename,
-- disconnect, expire, refresh failure, owner mismatch, …) appends a row.
-- Mirrors `order_events` so forensic "who did what, when" is consistent
-- across the two main user-facing surfaces (orders, connections).
--
-- connectionId is NOT a foreign key on purpose — the audit must outlive
-- its parent connection. Disconnect deletes the connection but leaves a
-- final "disconnected" event so the trail isn't lost.

--> statement-breakpoint
CREATE TABLE `connection_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `connectionId` INT NOT NULL,
  `userId` INT NOT NULL,
  `eventType` VARCHAR(32) NOT NULL,
  `source` VARCHAR(16) NOT NULL,
  `details` JSON DEFAULT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_connection_events_connection` (`connectionId`, `createdAt`),
  KEY `idx_connection_events_user_created` (`userId`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration 0043: Unified connections table scaffold (Step 1 of connection architecture).
--
-- ADDITIVE ONLY — no existing rows, columns, or logic are touched.
-- Existing destinations continue to work exactly as before via templateConfig.
-- connectionId on target_websites is NULL for all rows after this migration.
-- Delivery code reads credentials from templateConfig until Step 2 backfill.
--
-- Two changes:
--   1. CREATE TABLE connections
--   2. ALTER TABLE target_websites ADD COLUMN connectionId (nullable)

--> statement-breakpoint

-- ─── 1. connections ────────────────────────────────────────────────────────────
-- Make.com-style unified credential store.
-- type='google_sheets' → googleAccountId points to google_accounts.id
-- type='telegram_bot' | 'api_key' → credentialsJson holds encrypted credentials

CREATE TABLE `connections` (
  `id`              int NOT NULL AUTO_INCREMENT,
  `userId`          int NOT NULL,
  `type`            ENUM('google_sheets','telegram_bot','api_key') NOT NULL,
  `displayName`     varchar(255) NOT NULL,
  `status`          ENUM('active','expired','revoked','error') NOT NULL DEFAULT 'active',
  -- Soft FK → google_accounts.id (used when type='google_sheets').
  -- ON DELETE SET NULL: if the underlying Google account is removed,
  -- this field becomes NULL instead of blocking the delete.
  `googleAccountId` int NULL,
  -- Encrypted credential blob for telegram_bot / api_key types.
  -- Shape: telegram_bot → { botTokenEncrypted, chatId }
  --        api_key      → { keyEncrypted }
  `credentialsJson` json NULL,
  `lastVerifiedAt`  timestamp NULL,
  `createdAt`       timestamp NOT NULL DEFAULT (now()),
  `updatedAt`       timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `connections_id` PRIMARY KEY (`id`),
  CONSTRAINT `fk_connections_google_account`
    FOREIGN KEY (`googleAccountId`)
    REFERENCES `google_accounts` (`id`)
    ON DELETE SET NULL,
  KEY `idx_connections_user_id`   (`userId`),
  KEY `idx_connections_user_type` (`userId`, `type`)
);

--> statement-breakpoint

-- ─── 2. target_websites.connectionId ──────────────────────────────────────────
-- Nullable FK column — NULL for ALL existing rows after this migration.
-- Step 2 (safe backfill) will populate it without changing delivery behavior.
-- ALGORITHM=INSTANT: MySQL 8.0 adds the column without rewriting the table.

ALTER TABLE `target_websites`
  ADD COLUMN `connectionId` int NULL,
  ALGORITHM=INSTANT;

--> statement-breakpoint

-- Index and FK constraint as separate statements (FK requires index to exist first).

ALTER TABLE `target_websites`
  ADD KEY `idx_target_websites_connection_id` (`connectionId`),
  ADD CONSTRAINT `fk_target_websites_connection`
    FOREIGN KEY (`connectionId`)
    REFERENCES `connections` (`id`)
    ON DELETE SET NULL;

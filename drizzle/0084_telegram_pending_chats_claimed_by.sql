-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0084 — add telegram_pending_chats.claimedByUserId.
--
-- Context: when @Targenixbot is added to a group/channel, Telegram's
-- my_chat_member update carries `from` — the Telegram user who added it.
-- Until now the webhook ignored that field and just posted the raw Chat ID
-- into the chat for the user to copy/paste on the website.
--
-- With this column the webhook can match `from.id` against
-- users.telegramUserId / users.telegramChatId and remember which Targenix
-- account a pending (bot-added-but-not-yet-admin) chat belongs to. The UI
-- then shows that chat as "waiting for admin rights" to the right user —
-- no copy/paste. Once the bot is promoted to admin it is moved into
-- telegram_chats as a DELIVERY chat automatically.
--
-- NULL = chat was added by someone we can't tie to an account yet
-- (e.g. a teammate who never connected Telegram) — falls back to the old
-- manual "enter Chat ID" path, which still exists.
--
-- Cost: MySQL 8 InnoDB ADD COLUMN with no default and nullable is
-- INSTANT DDL (metadata only). Existing rows get NULL.
--
-- Idempotency: guarded.
--
-- Rollback: see 0084_rollback_telegram_pending_chats_claimed_by.sql.
-- ──────────────────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'telegram_pending_chats'
     AND column_name = 'claimedByUserId'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE telegram_pending_chats ADD COLUMN claimedByUserId INT NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'telegram_pending_chats'
     AND index_name = 'idx_telegram_pending_chats_claimed_by'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_telegram_pending_chats_claimed_by ON telegram_pending_chats (claimedByUserId)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- Rollback for 0084 — drop telegram_pending_chats.claimedByUserId and its
-- index. Loses the chat→account association for any pending chats recorded
-- since the forward migration applied; those chats fall back to the manual
-- "enter Chat ID" path. No DELIVERY chats are affected (they live in
-- telegram_chats).

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'telegram_pending_chats'
     AND index_name = 'idx_telegram_pending_chats_claimed_by'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_telegram_pending_chats_claimed_by ON telegram_pending_chats',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'telegram_pending_chats'
     AND column_name = 'claimedByUserId'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE telegram_pending_chats DROP COLUMN claimedByUserId',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

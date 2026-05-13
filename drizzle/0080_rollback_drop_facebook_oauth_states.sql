-- Rollback for 0080_drop_facebook_oauth_states.sql
-- Recreates the legacy table with the same shape it had pre-drop.
-- NOTE: dropped row data is NOT recovered — rows are transient CSRF state
-- tokens with a 10-minute TTL, so the table's lifetime data is meaningless.

SET @tbl_exists := (
  SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = DATABASE()
     AND table_name = 'facebook_oauth_states'
);
SET @stmt := IF(@tbl_exists = 0,
  'CREATE TABLE `facebook_oauth_states` (
    `id` int AUTO_INCREMENT NOT NULL,
    `state` varchar(128) NOT NULL,
    `userId` int NOT NULL,
    `expiresAt` timestamp NOT NULL,
    `createdAt` timestamp NOT NULL DEFAULT (now()),
    CONSTRAINT `facebook_oauth_states_id` PRIMARY KEY(`id`),
    CONSTRAINT `uq_facebook_oauth_states_state` UNIQUE(`state`),
    KEY `idx_facebook_oauth_states_user_id` (`userId`)
  )',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

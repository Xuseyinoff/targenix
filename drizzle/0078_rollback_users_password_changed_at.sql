-- Rollback for 0078 — drop users.passwordChangedAt. Loses any
-- rotation timestamps written since the forward migration applied;
-- sessions issued before those resets become valid again.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'passwordChangedAt'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE users DROP COLUMN passwordChangedAt',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

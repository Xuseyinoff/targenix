-- Rollback for 0091 — drop the three destinations secondary indexes.
--
-- No data loss: dropping a non-PK index only removes the lookup
-- structure. The base table rows are untouched.

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_destinations_user_id'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_destinations_user_id ON destinations',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_destinations_user_app'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_destinations_user_app ON destinations',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_destinations_connection_id'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_destinations_connection_id ON destinations',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- Step 4 (rollback): re-create the legacy index name so the pre-0091
-- state is fully restored. Idempotent: skipped if already present.
SET @legacy_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'destinations'
     AND index_name = 'idx_target_websites_connection_id'
);
SET @stmt := IF(@legacy_exists = 0,
  'CREATE INDEX idx_target_websites_connection_id ON destinations (connectionId)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

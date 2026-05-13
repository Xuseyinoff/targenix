-- Rollback for 0079_lead_retry_state.sql
-- Drops the retry-state columns + index from `leads`. Idempotent.

-- idx_leads_data_retry_due
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND index_name = 'idx_leads_data_retry_due'
);
SET @stmt := IF(@idx_exists > 0,
  'DROP INDEX idx_leads_data_retry_due ON leads',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- dataErrorType
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND column_name = 'dataErrorType'
);
SET @stmt := IF(@col_exists > 0,
  'ALTER TABLE leads DROP COLUMN dataErrorType',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- dataNextRetryAt
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND column_name = 'dataNextRetryAt'
);
SET @stmt := IF(@col_exists > 0,
  'ALTER TABLE leads DROP COLUMN dataNextRetryAt',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- dataAttempts
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND column_name = 'dataAttempts'
);
SET @stmt := IF(@col_exists > 0,
  'ALTER TABLE leads DROP COLUMN dataAttempts',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

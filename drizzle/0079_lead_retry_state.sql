-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0079 — lead Graph-enrichment retry state.
--
-- Mirrors orders.attempts / nextRetryAt for failed Facebook Graph fetches.
-- Before this migration the hourly retry scheduler was a thundering herd: it
-- pulled every dataStatus='ERROR' row and re-dispatched, with no per-lead
-- backoff or cap. Permanently-missing leadgenIds (Graph code 100 subcode 33)
-- got hammered forever.
--
-- Columns:
--   dataAttempts     — completed Graph enrichment attempts (cap stops retry)
--   dataNextRetryAt  — null = no retry scheduled; per-tick claim sets to NULL
--   dataErrorType    — classified outcome of last failure (network/auth/
--                       validation/rate_limit/permanently_missing). Drives
--                       the backoff ladder + giveup decision.
--
-- Index lets the scheduler's `SELECT … FOR UPDATE SKIP LOCKED` walk only
-- due rows instead of the whole error pool.
--
-- Cost: MySQL 8 InnoDB — three ADD COLUMNs with no defaults rewrite metadata
-- only (INSTANT DDL). Index creation is online. Safe on the live leads
-- table even at ~180k rows.
--
-- Idempotency: each ADD/CREATE guarded by an information_schema check.
--
-- Rollback: see 0079_rollback_lead_retry_state.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- dataAttempts
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND column_name = 'dataAttempts'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE leads ADD COLUMN dataAttempts INT NOT NULL DEFAULT 0',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- dataNextRetryAt
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND column_name = 'dataNextRetryAt'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE leads ADD COLUMN dataNextRetryAt TIMESTAMP NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- dataErrorType
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND column_name = 'dataErrorType'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE leads ADD COLUMN dataErrorType VARCHAR(32) NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- idx_leads_data_retry_due — scheduler scan
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'leads'
     AND index_name = 'idx_leads_data_retry_due'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_leads_data_retry_due ON leads (dataStatus, dataNextRetryAt, dataAttempts)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0078 — add users.passwordChangedAt for session invalidation.
--
-- Context: JWT cookies are stateless. Until now, resetting a password
-- did not invalidate existing sessions — a stolen cookie kept working.
-- After this migration, signSession() embeds `iat` (issued-at) in every
-- JWT and verifySession() rejects tokens whose `iat` predates the user's
-- `passwordChangedAt`.
--
-- Cost: MySQL 8 InnoDB ADD COLUMN with no default and no NOT NULL is
-- INSTANT DDL (metadata only). Existing rows get NULL — sessions for
-- users who never reset are unaffected.
--
-- Idempotency: guarded.
--
-- Rollback: see 0078_rollback_users_password_changed_at.sql.
-- ──────────────────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'users'
     AND column_name = 'passwordChangedAt'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE users ADD COLUMN passwordChangedAt TIMESTAMP NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

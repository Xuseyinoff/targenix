-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for migration 0092 — drop the functional unique index.
--
-- Run if 0092 ever needs to be reverted (e.g. an unforeseen edge case
-- starts blocking legitimate creates). Application code should be redeployed
-- without the pre-check first so the constraint isn't the only thing
-- preventing a hot bug.
-- ──────────────────────────────────────────────────────────────────────────

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'integrations'
     AND index_name = 'uniq_integrations_live_form_dest'
);
SET @stmt := IF(@idx_exists > 0,
  'DROP INDEX uniq_integrations_live_form_dest ON integrations',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;

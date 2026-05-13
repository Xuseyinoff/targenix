-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for migration 0081 — drop admin_audit_log.
--
-- Data loss: yes — all admin audit rows are lost. Export first if a
-- forensic record needs to be preserved:
--   SELECT * FROM admin_audit_log
--    INTO OUTFILE '/tmp/admin_audit_log_backup.csv'
--    FIELDS TERMINATED BY ',' ENCLOSED BY '"'
--    LINES TERMINATED BY '\n';
--
-- Idempotency: DROP TABLE IF EXISTS — safe to re-run.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS `admin_audit_log`;

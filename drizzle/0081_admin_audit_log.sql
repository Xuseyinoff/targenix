-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0081 — admin audit log table.
--
-- Roadmap #12: forensic record of every admin-protected tRPC mutation.
-- Captures (adminId, path, input, result, duration, ip, user-agent) for
-- every call to adminProcedure or templateEditorProcedure.
--
-- Why a dedicated table (and not connection_events / app_logs):
--   - connection_events is scoped to a single connection — admins act on
--     many global tables (apps, app_actions, destination_templates).
--   - app_logs is a flat operational stream; queries by adminId would
--     fight unrelated rows. A dedicated table keeps the audit signal-to-
--     noise high and the indices small.
--
-- adminId is intentionally NOT a foreign key. The audit row must outlive
-- the user record so deleting a user (rare, but possible) cannot erase
-- their action history. Same pattern as connection_events.connectionId.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS — safe to re-run.
-- Rollback:    see 0081_rollback_admin_audit_log.sql.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `admin_audit_log` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `adminId`      INT NOT NULL,
  `path`         VARCHAR(128) NOT NULL,
  `type`         VARCHAR(16)  NOT NULL,
  `input`        JSON DEFAULT NULL,
  `resultStatus` VARCHAR(16)  NOT NULL,
  `errorCode`    VARCHAR(64)  DEFAULT NULL,
  `errorMessage` VARCHAR(500) DEFAULT NULL,
  `durationMs`   INT NOT NULL DEFAULT 0,
  `ipAddress`    VARCHAR(64)  DEFAULT NULL,
  `userAgent`    VARCHAR(256) DEFAULT NULL,
  `createdAt`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_admin_audit_admin_created` (`adminId`, `createdAt`),
  KEY `idx_admin_audit_path_created`  (`path`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration 0067 — Per-destination Circuit Breaker (Shadow Mode / Phase 0)
--
-- Adds two tables backing the per-(integration, destination) circuit breaker:
--   integration_health         — current CB state (one row per dest, upserted)
--   integration_health_events  — immutable transition + probe audit log
--
-- Phase 0 = SHADOW mode: rows are written on every delivery outcome but the
-- scheduler does NOT yet enforce the breaker (no JOIN against this table in
-- the claim query). Enforcement lands in Phase 1 behind CB_ENFORCEMENT flag.
--
-- Granularity: (integrationId, destinationId). destinationId=0 represents the
-- whole integration (legacy single-destination orders); destinationId>0 is a
-- specific integration_destinations row, enabling independent breakers per
-- fan-out destination.

--> statement-breakpoint
CREATE TABLE `integration_health` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `integrationId`         INT NOT NULL,
  `destinationId`         INT NOT NULL DEFAULT 0,
  `state`                 ENUM('CLOSED','OPEN','HALF_OPEN') NOT NULL DEFAULT 'CLOSED',

  `windowStartedAt`       TIMESTAMP NULL DEFAULT NULL,
  `windowFailures`        INT NOT NULL DEFAULT 0,
  `windowSuccesses`       INT NOT NULL DEFAULT 0,

  `consecutiveFailures`   INT NOT NULL DEFAULT 0,
  `consecutiveSuccesses`  INT NOT NULL DEFAULT 0,

  `openedAt`              TIMESTAMP NULL DEFAULT NULL,
  `cooldownUntil`         TIMESTAMP NULL DEFAULT NULL,
  `cooldownLevel`         INT NOT NULL DEFAULT 0,

  `lastErrorType`         VARCHAR(32)  DEFAULT NULL,
  `lastErrorMessage`      VARCHAR(500) DEFAULT NULL,
  `lastTripReason`        VARCHAR(64)  DEFAULT NULL,

  `halfOpenAttempts`      INT NOT NULL DEFAULT 0,
  `halfOpenSuccesses`     INT NOT NULL DEFAULT 0,

  `manualLock`            ENUM('OPEN','CLOSED') DEFAULT NULL,
  `manualLockSetBy`       VARCHAR(128) DEFAULT NULL,
  `manualLockReason`      TEXT DEFAULT NULL,
  `manualLockSetAt`       TIMESTAMP NULL DEFAULT NULL,

  `createdAt`             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_integration_health_dest` (`integrationId`, `destinationId`),
  KEY `idx_integration_health_state` (`state`, `cooldownUntil`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint
CREATE TABLE `integration_health_events` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `integrationId`  INT NOT NULL,
  `destinationId`  INT NOT NULL DEFAULT 0,
  `eventType`      VARCHAR(32) NOT NULL,
  `fromState`      VARCHAR(16) DEFAULT NULL,
  `toState`        VARCHAR(16) DEFAULT NULL,
  `reason`         VARCHAR(256) DEFAULT NULL,
  `errorType`      VARCHAR(32) DEFAULT NULL,
  `metadata`       JSON DEFAULT NULL,
  `createdAt`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ih_events_dest_time` (`integrationId`, `destinationId`, `createdAt`),
  KEY `idx_ih_events_type_time` (`eventType`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

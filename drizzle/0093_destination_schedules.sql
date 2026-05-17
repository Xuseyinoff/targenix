-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0093 — destination_schedules + destination_pending_leads.
--
-- Yuboraman parity sprint, PR 4/4 Phase A. Adds the backend infrastructure
-- for per-destination daily pause scheduling (pause-time, start-time,
-- send-time) plus the queue that holds leads arriving during a pause
-- window. Frontend and lead-dispatch integration ship in later PRs.
--
-- Tables created (both idempotent):
--   1. `destination_schedules`        — 1-to-1 with destinations; 3 hour
--                                       fields + timezone + isPausedNow.
--   2. `destination_pending_leads`    — leads queued during pause; flushed
--                                       at sendHour by the per-minute
--                                       destinationFlushScheduler.
--
-- Indexes:
--   destination_schedules:
--     - uniq_destination_schedules_destinationId  (UNIQUE)
--         Enforces 1-to-1 with destinations and powers the per-destination
--         getSchedule/setSchedule lookup.
--     - idx_destination_schedules_userId          (userId)
--         Hot path for global procs (pauseAll, startAll, resetSchedules).
--     - idx_destination_schedules_paused          (isPausedNow)
--         Hot path for the dispatcher's "skip-if-paused" lookup in Phase B.
--
--   destination_pending_leads:
--     - idx_destination_pending_leads_destinationId  (destinationId)
--     - idx_destination_pending_leads_scheduledFor   (scheduledFor)
--     - idx_destination_pending_leads_undelivered    (destinationId, deliveredAt)
--         Covers the flush scheduler's "WHERE destinationId=? AND deliveredAt
--         IS NULL" scan.
--     - idx_destination_pending_leads_userId         (userId)
--         Hot path for flushPendingAll's per-user count.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS. The unique key on
-- destinationId is declared inline in the table, so on re-runs the
-- column simply pre-exists. No separate idempotency guard needed.
--
-- Cost: empty-table create on first apply; INSTANT DDL. On re-runs the
-- IF NOT EXISTS clause makes the statement a no-op.
--
-- Rollback: see 0093_rollback_destination_schedules.sql (DROP both
-- tables IF EXISTS).
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `destination_schedules` (
  `id`              INT          NOT NULL AUTO_INCREMENT,
  `destinationId`   INT          NOT NULL,
  /** Denormalized from destinations.userId so global procs scope without a JOIN. */
  `userId`          INT          NOT NULL,
  /** 0-23 hour-of-day in `timezone`. NULL means the corresponding transition is disabled. */
  `pauseHour`       INT          NULL,
  `startHour`       INT          NULL,
  `sendHour`        INT          NULL,
  /** IANA tz string. Default matches the primary user market. */
  `timezone`        VARCHAR(64)  NOT NULL DEFAULT 'Asia/Tashkent',
  /** Current pause state, maintained by the flush scheduler. */
  `isPausedNow`     BOOLEAN      NOT NULL DEFAULT FALSE,
  `createdAt`       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),

  /** 1-to-1 with destinations — enforces single schedule per destination. */
  UNIQUE KEY `uniq_destination_schedules_destinationId` (`destinationId`),

  /** Global procs: WHERE userId=? */
  KEY `idx_destination_schedules_userId`  (`userId`),
  /** Dispatcher fast-skip: WHERE isPausedNow=true (Phase B). */
  KEY `idx_destination_schedules_paused`  (`isPausedNow`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS `destination_pending_leads` (
  `id`              INT          NOT NULL AUTO_INCREMENT,
  `destinationId`   INT          NOT NULL,
  `leadId`          INT          NOT NULL,
  /** Denormalized for tenant-scoped queries. */
  `userId`          INT          NOT NULL,
  /** Snapshot of the dispatch payload at queue time — replayable independent of upstream mutations. */
  `payload`         JSON         NOT NULL,
  /** Computed next sendHour after queueing — when this row becomes eligible. */
  `scheduledFor`    TIMESTAMP    NULL,
  `createdAt`       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  /** Set when the flush scheduler dispatches the lead (Phase B). */
  `deliveredAt`     TIMESTAMP    NULL,
  /** Last delivery error message, surfaced in AdminLogs. */
  `deliveryError`   TEXT         NULL,
  `retryCount`      INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),

  KEY `idx_destination_pending_leads_destinationId`  (`destinationId`),
  KEY `idx_destination_pending_leads_scheduledFor`   (`scheduledFor`),
  /** Flush scheduler scan: WHERE destinationId=? AND deliveredAt IS NULL. */
  KEY `idx_destination_pending_leads_undelivered`    (`destinationId`, `deliveredAt`),
  /** Per-user count for flushPendingAll. */
  KEY `idx_destination_pending_leads_userId`         (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

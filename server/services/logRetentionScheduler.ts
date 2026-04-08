/**
 * logRetentionScheduler.ts
 *
 * Hourly log retention cleanup + SYSTEM log archival job.
 *
 * Retention policy:
 *   - USER logs (userId IS NOT NULL, logType = 'USER'):
 *       Normal users  → delete after 48 hours
 *       Admin users   → delete after 720 hours (30 days)
 *   - SYSTEM logs (logType = 'SYSTEM'):
 *       Keep for 30 days, then archive to app_logs_archive
 *       Purge archive entries older than 90 days
 *
 * Runs at the top of each hour.
 * Uses idx_app_logs_user_created_at and idx_app_logs_log_type indexes.
 */

import { and, eq, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { appLogs, users } from "../../drizzle/schema";

/** Retention windows */
export const RETENTION = {
  USER_HOURS: 48,          // 2 days for normal users
  ADMIN_HOURS: 720,        // 30 days for admin users
  SYSTEM_ARCHIVE_DAYS: 30, // Archive SYSTEM logs older than 30 days
  SYSTEM_PURGE_DAYS: 90,   // Purge archived SYSTEM logs older than 90 days
} as const;

/**
 * Archive SYSTEM logs older than SYSTEM_ARCHIVE_DAYS into app_logs_archive,
 * then delete them from app_logs. Also purge archive entries older than SYSTEM_PURGE_DAYS.
 *
 * Uses a raw SQL INSERT...SELECT for efficiency (single round-trip).
 */
async function archiveSystemLogs(): Promise<{ archived: number; purged: number }> {
  const db = await getDb();
  if (!db) return { archived: 0, purged: 0 };

  const archiveCutoff = new Date(Date.now() - RETENTION.SYSTEM_ARCHIVE_DAYS * 86_400_000);
  const purgeCutoff   = new Date(Date.now() - RETENTION.SYSTEM_PURGE_DAYS   * 86_400_000);

  // Ensure archive table exists (idempotent)
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS app_logs_archive (
      id          INT          NOT NULL,
      userId      INT,
      logType     ENUM('USER','SYSTEM') NOT NULL DEFAULT 'SYSTEM',
      level       ENUM('INFO','WARN','ERROR','DEBUG') NOT NULL DEFAULT 'INFO',
      category    VARCHAR(64)  NOT NULL,
      eventType   VARCHAR(64),
      source      VARCHAR(64),
      duration    INT,
      message     TEXT         NOT NULL,
      meta        JSON,
      leadId      INT,
      pageId      VARCHAR(128),
      createdAt   TIMESTAMP    NOT NULL,
      archivedAt  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_archive_created_at (createdAt),
      INDEX idx_archive_archived_at (archivedAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `));

  // 1. Copy old SYSTEM logs to archive (Drizzle sql tagged template — no raw ? placeholders)
  const insertResult = await db.execute(sql`
    INSERT IGNORE INTO app_logs_archive
      (id, userId, logType, level, category, eventType, source, duration, message, meta, leadId, pageId, createdAt)
    SELECT id, userId, logType, level, category, eventType, source, duration, message, meta, leadId, pageId, createdAt
    FROM app_logs
    WHERE logType = 'SYSTEM' AND createdAt < ${archiveCutoff}
  `);

  const archived: number = (insertResult as unknown as { affectedRows?: number })?.affectedRows ?? 0;

  // 2. Delete the archived rows from app_logs
  if (archived > 0) {
    await db.execute(sql`
      DELETE FROM app_logs WHERE logType = 'SYSTEM' AND createdAt < ${archiveCutoff}
    `);
  }

  // 3. Purge archive entries older than 90 days
  const purgeResult = await db.execute(sql`
    DELETE FROM app_logs_archive WHERE createdAt < ${purgeCutoff}
  `);

  const purged: number = (purgeResult as unknown as { affectedRows?: number })?.affectedRows ?? 0;

  return { archived, purged };
}

/**
 * Run the retention cleanup once.
 * Returns counts of deleted/archived rows per category.
 */
export async function runLogRetentionCleanup(): Promise<{
  deletedUser: number;
  deletedAdmin: number;
  archivedSystem: number;
  purgedArchive: number;
  total: number;
}> {
  const db = await getDb();
  if (!db) {
    console.warn("[LogRetention] DB not available, skipping cleanup");
    return { deletedUser: 0, deletedAdmin: 0, archivedSystem: 0, purgedArchive: 0, total: 0 };
  }

  const now = Date.now();
  const userCutoff  = new Date(now - RETENTION.USER_HOURS  * 3_600_000);
  const adminCutoff = new Date(now - RETENTION.ADMIN_HOURS * 3_600_000);

  // 1. Fetch all user IDs and their roles (small table, fast)
  const allUsers = await db.select({ id: users.id, role: users.role }).from(users);
  const adminIds = allUsers.filter((u) => u.role === "admin").map((u) => u.id);
  const userIds  = allUsers.filter((u) => u.role !== "admin").map((u) => u.id);

  let deletedUser  = 0;
  let deletedAdmin = 0;

  // 2. Delete old USER logs for normal users (48h cutoff)
  if (userIds.length > 0) {
    for (const uid of userIds) {
      const result = await db
        .delete(appLogs)
        .where(and(eq(appLogs.userId, uid), eq(appLogs.logType, "USER"), lt(appLogs.createdAt, userCutoff)));
      deletedUser += (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
    }
  }

  // 3. Delete old USER logs for admin users (30d cutoff)
  if (adminIds.length > 0) {
    for (const uid of adminIds) {
      const result = await db
        .delete(appLogs)
        .where(and(eq(appLogs.userId, uid), eq(appLogs.logType, "USER"), lt(appLogs.createdAt, adminCutoff)));
      deletedAdmin += (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
    }
  }

  // 4. Archive SYSTEM logs older than 30 days, purge archive older than 90 days
  const { archived: archivedSystem, purged: purgedArchive } = await archiveSystemLogs();

  const total = deletedUser + deletedAdmin + archivedSystem;

  console.log(
    `[LogRetention] ${new Date().toISOString()} — ` +
    `deleted users=${deletedUser} admins=${deletedAdmin} | ` +
    `archived system=${archivedSystem} purged archive=${purgedArchive} | total=${total}`
  );

  return { deletedUser, deletedAdmin, archivedSystem, purgedArchive, total };
}

/** Calculate ms until the next top-of-the-hour */
function msUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

let retentionTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the hourly log retention + archival scheduler.
 * Fires at the top of each hour. Safe to call multiple times.
 */
export function startLogRetentionScheduler(): void {
  if (retentionTimer !== null) return; // already running

  const scheduleNext = () => {
    const delay = msUntilNextHour();
    const nextRun = new Date(Date.now() + delay);
    console.log(
      `[LogRetention] Next run at ${nextRun.toISOString()} ` +
      `(in ${Math.round(delay / 60000)} min) — ` +
      `policy: users=48h, admins=30d, system archive=30d, purge=90d`
    );

    retentionTimer = setTimeout(() => {
      void runLogRetentionCleanup();
      retentionTimer = null;
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

/**
 * Stop the scheduler (useful in tests).
 */
export function stopLogRetentionScheduler(): void {
  if (retentionTimer !== null) {
    clearTimeout(retentionTimer);
    retentionTimer = null;
  }
}

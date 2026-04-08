import { z } from "zod";
import { desc, and, eq, like, gte, lte, count, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { appLogs } from "../../drizzle/schema";

// ─── Admin guard helper ────────────────────────────────────────────────────────
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

export const logsRouter = router({
  /**
   * List log entries — regular users see only their own logs (USER type).
   * Admins can filter across all users with full field access.
   *
   * Uses indexes:
   *   - idx_app_logs_user_created_at  (userId, createdAt) — user-scoped queries
   *   - idx_app_logs_log_type         (logType)           — admin logType filter
   *   - idx_app_logs_event_type       (eventType)         — admin eventType filter
   *   - idx_app_logs_created_at       (createdAt)         — date range queries
   *
   * Max 100 rows per page (enforced).
   */
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        level: z.enum(["INFO", "WARN", "ERROR", "DEBUG"]).optional(),
        category: z
          .enum(["WEBHOOK", "LEAD", "ORDER", "SYSTEM", "HTTP", "FACEBOOK", "TELEGRAM", "AFFILIATE"])
          .optional(),
        search: z.string().max(200).optional(),
        since: z.date().optional(),
        until: z.date().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { logs: [], total: 0 };

      const conditions = [];

      // Regular users only see their own USER-type logs
      if (ctx.user.role !== "admin") {
        conditions.push(eq(appLogs.userId, ctx.user.id));
        conditions.push(eq(appLogs.logType, "USER"));
      }

      if (input.level) conditions.push(eq(appLogs.level, input.level));
      if (input.category) conditions.push(eq(appLogs.category, input.category));
      if (input.search) conditions.push(like(appLogs.message, `%${input.search}%`));
      if (input.since) conditions.push(gte(appLogs.createdAt, input.since));
      if (input.until) conditions.push(lte(appLogs.createdAt, input.until));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, [{ total }]] = await Promise.all([
        db
          .select()
          .from(appLogs)
          .where(where)
          .orderBy(desc(appLogs.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: count() })
          .from(appLogs)
          .where(where),
      ]);

      return { logs: rows, total: total ?? 0 };
    }),

  /**
   * Admin-only: full log filter API with all observability fields.
   *
   * GET /trpc/logs.adminList
   * Equivalent to: GET /admin/logs?userId=&logType=&eventType=&since=&until=&limit=&offset=
   */
  adminList: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        /** Filter by specific user ID */
        userId: z.number().optional(),
        /** Filter by log type: USER (attributed) or SYSTEM (infrastructure) */
        logType: z.enum(["USER", "SYSTEM"]).optional(),
        /** Filter by structured event type */
        eventType: z.string().max(64).optional(),
        /** Filter by log level */
        level: z.enum(["INFO", "WARN", "ERROR", "DEBUG"]).optional(),
        /** Filter by category */
        category: z
          .enum(["WEBHOOK", "LEAD", "ORDER", "SYSTEM", "HTTP", "FACEBOOK", "TELEGRAM", "AFFILIATE"])
          .optional(),
        /** Filter by source */
        source: z.string().max(64).optional(),
        /** Full-text search on message */
        search: z.string().max(200).optional(),
        /** Start of date range (inclusive) */
        since: z.date().optional(),
        /** End of date range (inclusive) */
        until: z.date().optional(),
        /** Filter to only logs with duration recorded */
        withDuration: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { logs: [], total: 0 };

      const conditions = [];

      // Indexed filters first (most selective → least selective)
      if (input.userId != null) conditions.push(eq(appLogs.userId, input.userId));
      if (input.logType) conditions.push(eq(appLogs.logType, input.logType));
      if (input.eventType) conditions.push(eq(appLogs.eventType, input.eventType));
      if (input.level) conditions.push(eq(appLogs.level, input.level));
      if (input.category) conditions.push(eq(appLogs.category, input.category));
      if (input.source) conditions.push(eq(appLogs.source, input.source));
      if (input.since) conditions.push(gte(appLogs.createdAt, input.since));
      if (input.until) conditions.push(lte(appLogs.createdAt, input.until));
      // Non-indexed filters last
      if (input.search) conditions.push(like(appLogs.message, `%${input.search}%`));
      if (input.withDuration) conditions.push(isNotNull(appLogs.duration));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, [{ total }]] = await Promise.all([
        db
          .select()
          .from(appLogs)
          .where(where)
          .orderBy(desc(appLogs.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: count() })
          .from(appLogs)
          .where(where),
      ]);

      return { logs: rows, total: total ?? 0 };
    }),

  /**
   * Get counts grouped by level for the badge summary.
   * Regular users see only their own USER logs.
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0, total: 0 };

    const conditions =
      ctx.user.role !== "admin"
        ? and(eq(appLogs.userId, ctx.user.id), eq(appLogs.logType, "USER"))
        : undefined;

    const rows = await db
      .select({ level: appLogs.level, cnt: count() })
      .from(appLogs)
      .where(conditions)
      .groupBy(appLogs.level);

    const stats: Record<string, number> = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0, total: 0 };
    for (const row of rows) {
      stats[row.level] = row.cnt;
      stats.total += row.cnt;
    }
    return stats;
  }),

  /**
   * Admin-only: aggregated stats by logType, eventType, source.
   * Useful for observability dashboards.
   */
  adminStats: adminProcedure
    .input(
      z.object({
        since: z.date().optional(),
        until: z.date().optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { byLogType: [], byEventType: [], bySource: [], byLevel: [] };

      const dateConditions = [];
      if (input.since) dateConditions.push(gte(appLogs.createdAt, input.since));
      if (input.until) dateConditions.push(lte(appLogs.createdAt, input.until));
      const where = dateConditions.length > 0 ? and(...dateConditions) : undefined;

      const [byLogType, byEventType, bySource, byLevel] = await Promise.all([
        db.select({ logType: appLogs.logType, cnt: count() }).from(appLogs).where(where).groupBy(appLogs.logType),
        db.select({ eventType: appLogs.eventType, cnt: count() }).from(appLogs).where(where).groupBy(appLogs.eventType).orderBy(desc(count())).limit(20),
        db.select({ source: appLogs.source, cnt: count() }).from(appLogs).where(where).groupBy(appLogs.source),
        db.select({ level: appLogs.level, cnt: count() }).from(appLogs).where(where).groupBy(appLogs.level),
      ]);

      return { byLogType, byEventType, bySource, byLevel };
    }),

  /**
   * Clear logs — admin clears all, regular users clear their own.
   */
  clear: protectedProcedure
    .input(
      z.object({
        olderThanDays: z.number().min(0).default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { deleted: 0 };

      const conditions = [];

      // Regular users can only clear their own logs
      if (ctx.user.role !== "admin") {
        conditions.push(eq(appLogs.userId, ctx.user.id));
      }

      if (input.olderThanDays > 0) {
        const cutoff = new Date(Date.now() - input.olderThanDays * 86400000);
        conditions.push(lte(appLogs.createdAt, cutoff));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      await db.delete(appLogs).where(where);
      return { success: true };
    }),
});

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

/**
 * Logs API — admin-only. End-user Activity UI was removed; USER logs still
 * written by the app for retention / admin observability via adminList.
 */
export const logsRouter = router({
  /**
   * Admin-only: full log filter API with all observability fields.
   */
  adminList: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        userId: z.number().optional(),
        logType: z.enum(["USER", "SYSTEM"]).optional(),
        eventType: z.string().max(64).optional(),
        level: z.enum(["INFO", "WARN", "ERROR", "DEBUG"]).optional(),
        category: z
          .enum(["WEBHOOK", "LEAD", "ORDER", "SYSTEM", "HTTP", "FACEBOOK", "TELEGRAM", "AFFILIATE"])
          .optional(),
        source: z.string().max(64).optional(),
        search: z.string().max(200).optional(),
        since: z.date().optional(),
        until: z.date().optional(),
        withDuration: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { logs: [], total: 0 };

      const conditions = [];

      if (input.userId != null) conditions.push(eq(appLogs.userId, input.userId));
      if (input.logType) conditions.push(eq(appLogs.logType, input.logType));
      if (input.eventType) conditions.push(eq(appLogs.eventType, input.eventType));
      if (input.level) conditions.push(eq(appLogs.level, input.level));
      if (input.category) conditions.push(eq(appLogs.category, input.category));
      if (input.source) conditions.push(eq(appLogs.source, input.source));
      if (input.since) conditions.push(gte(appLogs.createdAt, input.since));
      if (input.until) conditions.push(lte(appLogs.createdAt, input.until));
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
   * Admin-only: aggregated stats by logType, eventType, source.
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
        db
          .select({ eventType: appLogs.eventType, cnt: count() })
          .from(appLogs)
          .where(where)
          .groupBy(appLogs.eventType)
          .orderBy(desc(count()))
          .limit(20),
        db.select({ source: appLogs.source, cnt: count() }).from(appLogs).where(where).groupBy(appLogs.source),
        db.select({ level: appLogs.level, cnt: count() }).from(appLogs).where(where).groupBy(appLogs.level),
      ]);

      return { byLogType, byEventType, bySource, byLevel };
    }),
});

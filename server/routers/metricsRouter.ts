/**
 * metricsRouter — Phase 10 observability endpoints.
 *
 * All procedures are admin-only. The dashboard uses these to render:
 *   • Summary cards   (overview)
 *   • Daily chart     (timeSeries)
 *   • Adapter table   (adapterBreakdown)
 *   • Error pie       (errorDistribution)
 *   • Queue cards     (queueStats)
 *   • Circuit table   (circuitBreakers)
 *   • Integration tbl (integrationBreakdown)
 */

import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { TRPCError } from "@trpc/server";
import {
  getPeriodStats,
  getDailyTimeSeries,
  getAdapterBreakdown,
  getErrorDistribution,
  getQueueStats,
  getIntegrationBreakdown,
} from "../services/metricsService";
// Circuit breaker procedures removed in Sprint 1 / Item 1.3 — see
// server/integrations/dispatch.ts header for the rationale.

const PERIOD_HOURS: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24,
  "7d":  7 * 24,
  "30d": 30 * 24,
};

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable." });
  return db;
}

export const metricsRouter = router({
  /**
   * High-level delivery stats for a given time period.
   * `userId: null` → global stats (all tenants).
   */
  overview: adminProcedure
    .input(
      z.object({
        period: z.enum(["24h", "7d", "30d"]).default("24h"),
        /** Scope to a specific user. Null = global admin view. */
        userId: z.number().int().positive().nullable().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      const hours = PERIOD_HOURS[input.period];
      return getPeriodStats(db, hours, input.userId ?? null);
    }),

  /**
   * Daily delivery volume + success/failure split for a chart.
   * Days is capped at 90 to avoid giant result sets.
   */
  timeSeries: adminProcedure
    .input(
      z.object({
        days:   z.number().int().min(1).max(90).default(30),
        userId: z.number().int().positive().nullable().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      return getDailyTimeSeries(db, input.days, input.userId ?? null);
    }),

  /** Per-adapter delivery breakdown (only for orders that have adapterKey set). */
  adapterBreakdown: adminProcedure
    .input(
      z.object({
        period: z.enum(["24h", "7d", "30d"]).default("7d"),
        userId: z.number().int().positive().nullable().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      return getAdapterBreakdown(db, PERIOD_HOURS[input.period], input.userId ?? null);
    }),

  /** Error type distribution for failed orders in the period. */
  errorDistribution: adminProcedure
    .input(
      z.object({
        period: z.enum(["24h", "7d", "30d"]).default("7d"),
        userId: z.number().int().positive().nullable().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      return getErrorDistribution(db, PERIOD_HOURS[input.period], input.userId ?? null);
    }),

  /** Order queue depth — pending / retryable / DLQ / overdue counts. */
  queueStats: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive().nullable().optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      return getQueueStats(db, input?.userId ?? null);
    }),

  /** Per-integration delivery stats. */
  integrationBreakdown: adminProcedure
    .input(
      z.object({
        period: z.enum(["24h", "7d", "30d"]).default("7d"),
        userId: z.number().int().positive().nullable().optional(),
        limit:  z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      return getIntegrationBreakdown(db, PERIOD_HOURS[input.period], input.userId ?? null, input.limit);
    }),

  /**
   * Sprint 5 / Item 5.4 — most recent SECURITY-category log entries.
   * Owner-mismatch attempts and other tenant-boundary violations land here
   * via Sprint 2.3. Surfaces on AdminMetrics so we notice cross-tenant
   * activity in near-real-time rather than tail-watching production logs.
   */
  securityFeed: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(20),
        sinceHours: z.number().int().min(1).max(720).default(168), // 7d default
      }),
    )
    .query(async ({ input }) => {
      const db = await requireDb();
      const { appLogs } = await import("../../drizzle/schema");
      const { gte, desc, eq, and } = await import("drizzle-orm");
      const since = new Date(Date.now() - input.sinceHours * 60 * 60 * 1000);
      const rows = await db
        .select({
          id: appLogs.id,
          level: appLogs.level,
          message: appLogs.message,
          eventType: appLogs.eventType,
          userId: appLogs.userId,
          meta: appLogs.meta,
          createdAt: appLogs.createdAt,
        })
        .from(appLogs)
        .where(and(eq(appLogs.category, "SECURITY"), gte(appLogs.createdAt, since)))
        .orderBy(desc(appLogs.createdAt))
        .limit(input.limit);
      return rows;
    }),

});

import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { integrations, leads, orders, targetWebsites, users } from "../../drizzle/schema";
import { and, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";
import { retryFailedOrderDelivery } from "../services/leadService";

export const adminDlqRouter = router({
  // ─── Delivery metrics overview ──────────────────────────────────────────────
  getStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return null;

    const now = new Date();
    const day1  = new Date(now.getTime() - 1  * 24 * 60 * 60 * 1000);
    const day7  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totals, last24h, last7d, last30d, dlqSize, retryable] = await Promise.all([
      // All-time counts by status
      db.select({
        status: orders.status,
        cnt: count(),
      })
        .from(orders)
        .groupBy(orders.status),

      // Last 24h
      db.select({ status: orders.status, cnt: count() })
        .from(orders)
        .where(gte(orders.createdAt, day1))
        .groupBy(orders.status),

      // Last 7d
      db.select({ status: orders.status, cnt: count() })
        .from(orders)
        .where(gte(orders.createdAt, day7))
        .groupBy(orders.status),

      // Last 30d
      db.select({ status: orders.status, cnt: count() })
        .from(orders)
        .where(gte(orders.createdAt, day30))
        .groupBy(orders.status),

      // Permanently failed (DLQ)
      db.select({ cnt: count() })
        .from(orders)
        .where(
          and(
            eq(orders.status, "FAILED"),
            gte(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
          ),
        ),

      // Retryable (failed but not exhausted)
      db.select({ cnt: count() })
        .from(orders)
        .where(
          and(
            eq(orders.status, "FAILED"),
            lt(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
          ),
        ),
    ]);

    const toCounts = (rows: { status: string; cnt: number }[]) => {
      const map: Record<string, number> = {};
      for (const r of rows) map[r.status] = r.cnt;
      return {
        SENT:    map["SENT"]    ?? 0,
        PENDING: map["PENDING"] ?? 0,
        FAILED:  map["FAILED"]  ?? 0,
      };
    };

    const calcRate = (counts: ReturnType<typeof toCounts>) => {
      const total = counts.SENT + counts.FAILED;
      return total > 0 ? Math.round((counts.SENT / total) * 100) : null;
    };

    const allTime = toCounts(totals);
    const d1      = toCounts(last24h);
    const d7      = toCounts(last7d);
    const d30     = toCounts(last30d);

    return {
      allTime:       { ...allTime,  successRate: calcRate(allTime) },
      last24h:       { ...d1,       successRate: calcRate(d1) },
      last7d:        { ...d7,       successRate: calcRate(d7) },
      last30d:       { ...d30,      successRate: calcRate(d30) },
      dlqSize:       dlqSize[0]?.cnt ?? 0,
      retryableSize: retryable[0]?.cnt ?? 0,
    };
  }),

  // ─── Per-day breakdown (last 14 days) ───────────────────────────────────────
  getDailyBreakdown: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        day:    sql<string>`DATE(${orders.createdAt})`,
        status: orders.status,
        cnt:    count(),
      })
      .from(orders)
      .where(gte(orders.createdAt, since))
      .groupBy(sql`DATE(${orders.createdAt})`, orders.status)
      .orderBy(sql`DATE(${orders.createdAt})`);

    // Pivot: { day, SENT, FAILED, PENDING }
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? {};
      d[r.status] = r.cnt;
      byDay.set(r.day, d);
    }

    return Array.from(byDay.entries()).map(([day, counts]) => ({
      day,
      sent:    counts["SENT"]    ?? 0,
      failed:  counts["FAILED"]  ?? 0,
      pending: counts["PENDING"] ?? 0,
    }));
  }),

  // ─── List permanently failed orders (DLQ) ──────────────────────────────────
  listFailed: adminProcedure
    .input(
      z.object({
        limit:  z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      const where = and(
        eq(orders.status, "FAILED"),
        gte(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
      );

      const [items, [{ total }]] = await Promise.all([
        db
          .select({
            orderId:         orders.id,
            leadId:          orders.leadId,
            attempts:        orders.attempts,
            lastAttemptAt:   orders.lastAttemptAt,
            createdAt:       orders.createdAt,
            responseData:    orders.responseData,
            leadName:        leads.fullName,
            leadPhone:       leads.phone,
            integrationName: integrations.name,
            appKey:          targetWebsites.appKey,
            userName:        users.name,
            userEmail:       users.email,
          })
          .from(orders)
          .innerJoin(leads,          eq(orders.leadId,          leads.id))
          .innerJoin(integrations,   eq(orders.integrationId,   integrations.id))
          .innerJoin(targetWebsites, eq(orders.destinationId,   targetWebsites.id))
          .innerJoin(users,          eq(orders.userId,          users.id))
          .where(where)
          .orderBy(desc(orders.lastAttemptAt))
          .limit(input.limit)
          .offset(input.offset),

        db
          .select({ total: sql<number>`COUNT(*)` })
          .from(orders)
          .where(where),
      ]);

      return { items, total };
    }),

  // ─── Force-retry a single permanently failed order ──────────────────────────
  retryOrder: adminProcedure
    .input(z.object({ orderId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      // Verify it is permanently failed
      const [order] = await db
        .select({ id: orders.id, attempts: orders.attempts, status: orders.status })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new Error("Order topilmadi");
      if (order.status !== "FAILED") throw new Error("Order FAILED statusda emas");

      // Reset to retryable state: attempts=0, nextRetryAt=now (due immediately)
      await db
        .update(orders)
        .set({ attempts: 0, nextRetryAt: new Date() })
        .where(eq(orders.id, input.orderId));

      // Immediately attempt delivery
      const result = await retryFailedOrderDelivery(input.orderId);
      return { outcome: result.outcome };
    }),

  // ─── Force-retry ALL permanently failed orders (batch reset) ────────────────
  retryAll: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const result = await db
      .update(orders)
      .set({ attempts: 0, nextRetryAt: new Date() })
      .where(
        and(
          eq(orders.status, "FAILED"),
          gte(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
        ),
      );

    const affected = (result as unknown as { rowsAffected?: number }[])
      ?.at(0)?.rowsAffected ?? 0;

    return { queued: affected };
  }),
});

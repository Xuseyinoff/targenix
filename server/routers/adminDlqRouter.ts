import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { integrations, leads, orders, targetWebsites, users } from "../../drizzle/schema";
import { and, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";
import { retryFailedOrderDelivery } from "../services/leadService";
import { evaluateClaim, evaluateAndMaybeBlock, previewBulkRetryCBState } from "../services/circuitBreaker";

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

  // ─── Pre-check the CB state for a single order before forcing retry ────────
  // Read-only. Used by the AdminDlq UI to render a "destination is OFFLINE
  // until X — Force anyway?" prompt before the destructive `retryOrder`
  // mutation runs.
  retryOrderPreview: adminProcedure
    .input(z.object({ orderId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [order] = await db
        .select({ id: orders.id, integrationId: orders.integrationId, destinationId: orders.destinationId })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      if (!order) throw new Error("Order topilmadi");
      const ev = await evaluateClaim(db, {
        integrationId: order.integrationId,
        destinationId: order.destinationId ?? 0,
      });
      return { orderId: order.id, ...ev };
    }),

  // ─── Force-retry a single permanently failed order ──────────────────────────
  //
  // Phase 1A: respects CB by default. Passing `force=true` bypasses an OPEN
  // destination and audits a `manual_force` event so we can spot a
  // destination that keeps getting bypassed.
  retryOrder: adminProcedure
    .input(z.object({ orderId: z.number(), force: z.boolean().optional().default(false) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      // Verify it is permanently failed
      const [order] = await db
        .select({
          id: orders.id,
          attempts: orders.attempts,
          status: orders.status,
          integrationId: orders.integrationId,
          destinationId: orders.destinationId,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) throw new Error("Order topilmadi");
      if (order.status !== "FAILED") throw new Error("Order FAILED statusda emas");

      // CB gate (Phase 1A — admin path enforces unless force=true)
      const guard = await evaluateAndMaybeBlock(db, {
        integrationId: order.integrationId,
        destinationId: order.destinationId ?? 0,
        options: { caller: "admin", force: input.force },
        metadata: { orderId: order.id, source: "adminDlq.retryOrder" },
      });
      if (guard.shouldBlock) {
        return {
          ok: false as const,
          outcome: "cb_blocked" as const,
          reason: guard.reason,
          state: guard.state,
          cooldownUntil: guard.cooldownUntil,
        };
      }

      // Reset to retryable state: attempts=0, nextRetryAt=now (due immediately)
      await db
        .update(orders)
        .set({ attempts: 0, nextRetryAt: new Date() })
        .where(eq(orders.id, input.orderId));

      // Immediately attempt delivery
      const result = await retryFailedOrderDelivery(input.orderId);
      return { ok: true as const, outcome: result.outcome, forced: guard.forced };
    }),

  // ─── Preview: what would retryAll touch? ───────────────────────────────────
  retryAllPreview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    return await previewBulkRetryCBState(db, { minAttempts: ORDER_MAX_DELIVERY_ATTEMPTS });
  }),

  // ─── Force-retry ALL permanently failed orders (batch reset) ────────────────
  //
  // Phase 1A: `mode='healthy_only'` (default) only resets orders whose
  // destination is NOT currently OPEN — the rest stay parked until the
  // breaker recovers. `mode='force'` reverts to legacy "reset everything"
  // and audits the override.
  retryAll: adminProcedure
    .input(
      z
        .object({
          mode: z.enum(["healthy_only", "force"]).default("healthy_only"),
        })
        .default({ mode: "healthy_only" }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const mode = input.mode;

      const baseWhere = and(
        eq(orders.status, "FAILED"),
        gte(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
      );

      if (mode === "force") {
        const result = await db
          .update(orders)
          .set({ attempts: 0, nextRetryAt: new Date() })
          .where(baseWhere);
        const affected =
          (result as unknown as { rowsAffected?: number }[])?.at(0)?.rowsAffected ?? 0;
        return { queued: affected, skipped: 0, mode };
      }

      // healthy_only: enumerate destinations, drop the OPEN ones, reset only
      // the orders that hit healthy destinations.
      const preview = await previewBulkRetryCBState(db, {
        minAttempts: ORDER_MAX_DELIVERY_ATTEMPTS,
      });
      const healthyDests = preview.byDestination.filter((d) => d.decision !== "block");
      const blockedDests = preview.byDestination.filter((d) => d.decision === "block");
      const skipped = blockedDests.reduce((acc, d) => acc + d.orderCount, 0);

      if (healthyDests.length === 0) {
        return { queued: 0, skipped, mode };
      }

      // One UPDATE per destination — small N (typically <20 distinct
      // destinations) keeps this cheap; alternative WHERE-IN over millions
      // of order ids would balloon the query.
      let totalQueued = 0;
      for (const d of healthyDests) {
        const result = await db
          .update(orders)
          .set({ attempts: 0, nextRetryAt: new Date() })
          .where(
            and(
              baseWhere,
              eq(orders.integrationId, d.integrationId),
              eq(orders.destinationId, d.destinationId),
            ),
          );
        const affected =
          (result as unknown as { rowsAffected?: number }[])?.at(0)?.rowsAffected ?? 0;
        totalQueued += affected;
      }

      return { queued: totalQueued, skipped, mode };
    }),
});

/**
 * Order-level auto-retry: re-sends FAILED integrations on a fixed interval
 * without re-running Facebook Graph enrichment (see retryFailedOrderDelivery).
 */

import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { orders } from "../../drizzle/schema";
import { getDb } from "../db";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";
import { retryFailedOrderDelivery } from "./leadService";

const DEFAULT_BATCH = 200;

/**
 * Prisma equivalent:
 * ```prisma
 * const due = await prisma.order.findMany({
 *   where: {
 *     status: 'FAILED',
 *     attempts: { lt: 3 },
 *     nextRetryAt: { lte: new Date() },
 *   },
 *   take: 200,
 *   orderBy: { nextRetryAt: 'asc' },
 * });
 * ```
 */
export async function retryDueFailedOrders(options?: { limit?: number }): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[OrderRetry] DB not available, skipping order retry run");
    return { retried: 0 };
  }

  const limit = options?.limit ?? DEFAULT_BATCH;
  const now = new Date();

  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "FAILED"),
        lt(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
        isNotNull(orders.nextRetryAt),
        lte(orders.nextRetryAt, now),
      ),
    )
    .limit(limit);

  if (due.length === 0) {
    console.log("[OrderRetry] No orders due for auto-retry");
    return { retried: 0 };
  }

  let retried = 0;
  for (const row of due) {
    try {
      const r = await retryFailedOrderDelivery(row.id);
      if (r.outcome === "sent" || r.outcome === "failed_exhausted" || r.outcome === "failed_will_retry") {
        retried += 1;
      }
    } catch (err) {
      console.error(`[OrderRetry] order ${row.id}:`, err);
    }
  }

  console.log(
    `[OrderRetry] ${new Date().toISOString()} — examined ${due.length} due order row(s), ${retried} delivery attempt(s) completed`,
  );
  return { retried };
}

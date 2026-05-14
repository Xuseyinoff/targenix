import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { orders } from "../../drizzle/schema";
import type { DbClient } from "../db";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";

/**
 * Lightweight in-process metrics.
 * - No external deps
 * - Best-effort: counters reset on process restart
 * - Logs only when explicitly asked by caller
 */

let failedOrdersCount = 0;
let oauthErrorsCount = 0;

export function incFailedOrders(n = 1): void {
  failedOrdersCount += Math.max(0, Math.floor(n));
}

export function incOAuthErrors(n = 1): void {
  oauthErrorsCount += Math.max(0, Math.floor(n));
}

/**
 * Atomically read the current cumulative counters AND reset them to zero.
 * Used by the metric snapshot scheduler so each persisted row represents
 * the activity in the interval `[previousSnapshot, now)` rather than the
 * cumulative-since-boot value (which loses meaning across restarts).
 *
 * The reads + writes here are not protected by a mutex because Node's
 * single-threaded event loop makes the +=/= sequence non-interleavable
 * with itself. A worker thread future would need an Atomics-backed pair.
 */
export function readAndResetCounters(): {
  failedOrders: number;
  oauthErrors: number;
} {
  const snapshot = { failedOrders: failedOrdersCount, oauthErrors: oauthErrorsCount };
  failedOrdersCount = 0;
  oauthErrorsCount = 0;
  return snapshot;
}

/** Read counters without mutating — useful for ad-hoc inspection and tests. */
export function peekCounters(): { failedOrders: number; oauthErrors: number } {
  return { failedOrders: failedOrdersCount, oauthErrors: oauthErrorsCount };
}

export async function getRetryQueueSize(db: DbClient): Promise<number> {
  const now = new Date();
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "FAILED"),
        lt(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
        isNotNull(orders.nextRetryAt),
        lte(orders.nextRetryAt, now),
      ),
    );
  return rows.length;
}

export async function getFailedOrdersCountDb(db: DbClient): Promise<number> {
  // Count FAILED regardless of nextRetryAt to capture backlog.
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "FAILED"), lt(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS)));
  return rows.length;
}

export async function logMetricsSnapshot(db: DbClient): Promise<void> {
  const [failedOrdersDb, retryQueue] = await Promise.all([
    getFailedOrdersCountDb(db),
    getRetryQueueSize(db),
  ]);

  console.log({
    stage: "metrics",
    failed_orders_count: failedOrdersCount,
    failed_orders_db: failedOrdersDb,
    retry_queue_size: retryQueue,
    oauth_errors_count: oauthErrorsCount,
  });
}


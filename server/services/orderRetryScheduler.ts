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
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RATE_PER_SEC = 5;

function createRateLimitedRunner(options: {
  concurrency: number;
  ratePerSecond: number;
}): {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  runAll(): Promise<void>;
  stop(): void;
} {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const ratePerSecond = Math.max(1, Math.floor(options.ratePerSecond));

  type Task = {
    fn: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };

  const queue: Task[] = [];
  let inFlight = 0;
  let tokens = ratePerSecond;
  let draining = false;

  const refillTimer = setInterval(() => {
    tokens = ratePerSecond;
    void drain();
  }, 1000);
  // Don't keep the process alive for the timer
  (refillTimer as unknown as { unref?: () => void })?.unref?.();

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (inFlight < concurrency && tokens > 0 && queue.length > 0) {
        const task = queue.shift()!;
        tokens -= 1;
        inFlight += 1;
        void task
          .fn()
          .then(task.resolve, task.reject)
          .finally(() => {
            inFlight -= 1;
            void drain();
          });
      }
    } finally {
      draining = false;
    }
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ fn: fn as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
      void drain();
    });
  }

  async function runAll(): Promise<void> {
    // Wait until both queue is empty and no tasks are in-flight.
    while (queue.length > 0 || inFlight > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function stop(): void {
    clearInterval(refillTimer);
  }

  return { enqueue, runAll, stop };
}

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
export async function retryDueFailedOrders(options?: {
  limit?: number;
  concurrency?: number;
  ratePerSecond?: number;
}): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[OrderRetry] DB not available, skipping order retry run");
    return { retried: 0 };
  }

  const limit = options?.limit ?? DEFAULT_BATCH;
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const ratePerSecond = options?.ratePerSecond ?? DEFAULT_RATE_PER_SEC;
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
  const runner = createRateLimitedRunner({ concurrency, ratePerSecond });
  try {
    await Promise.all(
      due.map((row) =>
        runner.enqueue(async () => {
          try {
            const r = await retryFailedOrderDelivery(row.id);
            if (r.outcome === "sent" || r.outcome === "failed_exhausted" || r.outcome === "failed_will_retry") {
              retried += 1;
            }
          } catch (err) {
            console.error(`[OrderRetry] order ${row.id}:`, err);
          }
        }),
      ),
    );
    await runner.runAll();
  } finally {
    runner.stop();
  }

  console.log(
    `[OrderRetry] ${new Date().toISOString()} — examined ${due.length} due order row(s), ${retried} delivery attempt(s) completed (concurrency=${concurrency}, rate=${ratePerSecond}/s)`,
  );
  return { retried };
}

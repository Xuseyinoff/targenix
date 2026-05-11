/**
 * Order-level auto-retry: picks FAILED orders whose `nextRetryAt` is due and
 * re-sends without re-running Facebook Graph enrichment (see retryFailedOrderDelivery).
 * Retry spacing is set on each failed attempt in `persistOrderDeliveryAttemptResult`.
 *
 * Sprint 1 / Item 1.2 — multi-worker race safety:
 *   The selector now claims rows inside a transaction with
 *   `FOR UPDATE SKIP LOCKED`. Each worker takes a distinct slice, atomically
 *   clears `nextRetryAt` so subsequent runs cannot re-claim, and only THEN
 *   commits and dispatches deliveries. Two workers running the scheduler
 *   concurrently will see disjoint batches; double-send is impossible.
 */

import { inArray, sql } from "drizzle-orm";
import { orders } from "../../drizzle/schema";
import { getDb } from "../db";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";
import { retryFailedOrderDelivery } from "./leadService";
import { getRetryQueueSize, logMetricsSnapshot } from "../monitoring/metrics";
import { evaluateClaim, recordShadowDecision } from "./circuitBreaker";

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw != null ? parseInt(String(raw).trim(), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_BATCH = envInt("RETRY_BATCH_SIZE", 500);
const DEFAULT_CONCURRENCY = envInt("RETRY_CONCURRENCY", 10);
const DEFAULT_RATE_PER_SEC = envInt("RETRY_RATE_PER_SEC", 20);

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

  let limit = options?.limit ?? DEFAULT_BATCH;
  let concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  let ratePerSecond = options?.ratePerSecond ?? DEFAULT_RATE_PER_SEC;
  const now = new Date();

  const queueSize = await getRetryQueueSize(db);
  if (queueSize > 1000) {
    // Temporary boost under backlog.
    limit = Math.min(limit * 2, 2000);
    ratePerSecond = Math.min(ratePerSecond * 2, 200);
    concurrency = Math.min(concurrency + 5, 50);
  }

  console.log({
    stage: "retry_scheduler",
    queueSize,
    batchSize: limit,
    rate: ratePerSecond,
    concurrency,
  });
  if (process.env.METRICS_LOG === "1") {
    await logMetricsSnapshot(db);
  }

  // Atomically claim a batch of due retries: locks the rows with
  // `FOR UPDATE SKIP LOCKED` (MySQL 8+), clears `nextRetryAt` so they
  // can no longer satisfy the WHERE clause in a parallel run, then
  // commits. Any concurrent scheduler hits the same query and walks
  // past the locked rows, picking a different slice. The actual
  // delivery work happens AFTER commit so we don't hold row locks
  // across HTTP calls.
  const due = await db.transaction(async (tx) => {
    const lockedRows = await tx.execute(sql`
      SELECT id, integrationId, destinationId FROM orders
      WHERE status = 'FAILED'
        AND attempts < ${ORDER_MAX_DELIVERY_ATTEMPTS}
        AND nextRetryAt IS NOT NULL
        AND nextRetryAt <= ${now}
      ORDER BY nextRetryAt ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const rows = ((lockedRows as unknown as [Array<{ id: number; integrationId: number; destinationId: number }>, unknown])[0] ?? [])
      .map((r) => ({
        id: Number(r.id),
        integrationId: Number(r.integrationId),
        destinationId: Number(r.destinationId ?? 0),
      }))
      .filter((r) => Number.isFinite(r.id) && r.id > 0);
    if (rows.length === 0) return [];
    // Claim by clearing nextRetryAt: future scheduler runs cannot re-claim
    // these rows because the WHERE clause requires `nextRetryAt IS NOT NULL`.
    // `retryFailedOrderDelivery` does NOT re-check nextRetryAt (the claim
    // makes that impossible) — it trusts that the caller validated due-ness.
    await tx
      .update(orders)
      .set({ nextRetryAt: null })
      .where(inArray(orders.id, rows.map((r) => r.id)));
    return rows;
  });

  if (due.length === 0) {
    console.log("[OrderRetry] No orders due for auto-retry");
    return { retried: 0 };
  }

  let retried = 0;
  // Phase 0 — shadow mode counters. We always dispatch (legacy behaviour),
  // but we record what the circuit breaker WOULD have done so we can verify
  // its thresholds against real traffic before turning enforcement on.
  let shadowBlocks = 0;
  let shadowProbes = 0;
  let shadowAllows = 0;

  const runner = createRateLimitedRunner({ concurrency, ratePerSecond });
  try {
    await Promise.all(
      due.map((row) =>
        runner.enqueue(async () => {
          // ── Phase 0 shadow CB evaluation ────────────────────────────────
          // Always proceed regardless of the decision; the audit row in
          // integration_health_events lets us count would-have-blocked
          // events offline and tune CIRCUIT_POLICY before enforcing.
          try {
            const ev = await evaluateClaim(db, {
              integrationId: row.integrationId,
              destinationId: row.destinationId,
            });
            if (ev.decision === "block") shadowBlocks++;
            else if (ev.decision === "probe") shadowProbes++;
            else shadowAllows++;
            await recordShadowDecision(db, {
              integrationId: row.integrationId,
              destinationId: row.destinationId,
              decision: ev.decision,
              state: ev.state,
              reason: ev.reason,
              legacyDispatched: true,
              metadata: { orderId: row.id },
            });
          } catch (err) {
            console.error("[OrderRetry] CB shadow eval failed for order", row.id, err);
          }

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

  if (shadowBlocks > 0 || shadowProbes > 0) {
    console.log(
      `[OrderRetry][CB-shadow] would-block=${shadowBlocks} would-probe=${shadowProbes} allow=${shadowAllows} (Phase 0 — no enforcement)`,
    );
  }

  console.log(
    `[OrderRetry] ${new Date().toISOString()} — examined ${due.length} due order row(s), ${retried} delivery attempt(s) completed (concurrency=${concurrency}, rate=${ratePerSecond}/s)`,
  );
  return { retried };
}

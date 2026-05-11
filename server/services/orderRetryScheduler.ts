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

import { eq, inArray, sql } from "drizzle-orm";
import { orders } from "../../drizzle/schema";
import { getDb } from "../db";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";
import { retryFailedOrderDelivery } from "./leadService";
import { getRetryQueueSize, logMetricsSnapshot } from "../monitoring/metrics";
import { evaluateAndMaybeBlock, getEnforcementScope, recordShadowDecision } from "./circuitBreaker";

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw != null ? parseInt(String(raw).trim(), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_BATCH = envInt("RETRY_BATCH_SIZE", 500);
const DEFAULT_CONCURRENCY = envInt("RETRY_CONCURRENCY", 10);
const DEFAULT_RATE_PER_SEC = envInt("RETRY_RATE_PER_SEC", 20);
const DEFAULT_PER_DEST_CONCURRENCY = envInt("RETRY_PER_DEST_CONCURRENCY", 2);

function createRateLimitedRunner(options: {
  concurrency: number;
  ratePerSecond: number;
  /**
   * Cap on simultaneous in-flight tasks sharing the same `groupKey`. With
   * `perGroupConcurrency=2` and groupKey="intId:destId" the runner will
   * never have more than 2 outstanding HTTP requests against the same
   * destination — partner APIs see a smoother traffic profile, and one
   * slow destination can't monopolise the global concurrency budget.
   * Tasks without a groupKey share an implicit "default" bucket.
   */
  perGroupConcurrency?: number;
}): {
  enqueue<T>(fn: () => Promise<T>, opts?: { groupKey?: string }): Promise<T>;
  runAll(): Promise<void>;
  stop(): void;
} {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const ratePerSecond = Math.max(1, Math.floor(options.ratePerSecond));
  const perGroupConcurrency = Math.max(
    1,
    Math.floor(options.perGroupConcurrency ?? Number.POSITIVE_INFINITY),
  );

  type Task = {
    fn: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    groupKey: string | null;
  };

  const queue: Task[] = [];
  let inFlight = 0;
  const inFlightByGroup = new Map<string, number>();
  let tokens = ratePerSecond;
  let draining = false;

  const refillTimer = setInterval(() => {
    tokens = ratePerSecond;
    void drain();
  }, 1000);
  (refillTimer as unknown as { unref?: () => void })?.unref?.();

  function groupCount(key: string | null): number {
    if (!key) return 0;
    return inFlightByGroup.get(key) ?? 0;
  }

  function pickNextRunnable(): number {
    // Find first task whose group is not at cap. Linear scan is fine —
    // the queue is small (one tick worth of due orders).
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i]!;
      if (groupCount(t.groupKey) < perGroupConcurrency) return i;
    }
    return -1;
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (inFlight < concurrency && tokens > 0 && queue.length > 0) {
        const idx = pickNextRunnable();
        if (idx < 0) break; // every remaining task is blocked by per-group cap
        const [task] = queue.splice(idx, 1);
        if (!task) break;
        tokens -= 1;
        inFlight += 1;
        if (task.groupKey) {
          inFlightByGroup.set(task.groupKey, groupCount(task.groupKey) + 1);
        }
        void task
          .fn()
          .then(task.resolve, task.reject)
          .finally(() => {
            inFlight -= 1;
            if (task.groupKey) {
              const after = groupCount(task.groupKey) - 1;
              if (after <= 0) inFlightByGroup.delete(task.groupKey);
              else inFlightByGroup.set(task.groupKey, after);
            }
            void drain();
          });
      }
    } finally {
      draining = false;
    }
  }

  function enqueue<T>(fn: () => Promise<T>, opts?: { groupKey?: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        groupKey: opts?.groupKey ?? null,
      });
      void drain();
    });
  }

  async function runAll(): Promise<void> {
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
  // Counters split by what the breaker decided, regardless of whether
  // enforcement is currently on or off. When enforcement is `all`, blocked
  // orders skip dispatch + get nextRetryAt reset to a short re-claim window
  // so they come back round once the cooldown lifts. When enforcement is
  // off or `admin_only`, the counts still show up in logs as observability
  // even though dispatch happens regardless.
  let cbBlocked = 0;
  let cbProbed = 0;
  let cbAllowed = 0;
  const enforced = getEnforcementScope() === "all";

  const runner = createRateLimitedRunner({
    concurrency,
    ratePerSecond,
    perGroupConcurrency: DEFAULT_PER_DEST_CONCURRENCY,
  });
  try {
    await Promise.all(
      due.map((row) =>
        runner.enqueue(async () => {
          // ── CB gate ─────────────────────────────────────────────────────
          // The groupKey passed to enqueue (`${intId}:${destId}`) caps how
          // many of THIS destination's orders can be in-flight at once
          // (default 2 — env RETRY_PER_DEST_CONCURRENCY). One slow partner
          // can't monopolise the global concurrency budget any more.
          // With CB_ENFORCEMENT=all this actually skips dispatch when the
          // breaker says block. Without it (admin_only / disabled), the
          // guard returns shouldBlock=false and we proceed as before, but
          // still emit shadow rows for offline analysis.
          let shouldSkip = false;
          try {
            const guard = await evaluateAndMaybeBlock(db, {
              integrationId: row.integrationId,
              destinationId: row.destinationId,
              options: { caller: "scheduler" },
              metadata: { orderId: row.id },
            });
            if (guard.decision === "block") cbBlocked++;
            else if (guard.decision === "probe") cbProbed++;
            else cbAllowed++;

            // Shadow-mode breadcrumb so we can compare enforcement on/off
            // outcomes in `integration_health_events`.
            await recordShadowDecision(db, {
              integrationId: row.integrationId,
              destinationId: row.destinationId,
              decision: guard.decision,
              state: guard.state,
              reason: guard.reason,
              legacyDispatched: !guard.shouldBlock,
              metadata: { orderId: row.id, enforced },
            });

            shouldSkip = guard.shouldBlock;
          } catch (err) {
            console.error("[OrderRetry] CB eval failed for order", row.id, err);
          }

          if (shouldSkip) {
            // Park the order on the breaker's cooldown so we don't keep
            // re-claiming it on every tick. Falls back to a short window
            // when cooldownUntil is unknown (e.g. manualLock).
            const fallbackMs = 5 * 60 * 1000;
            const nextRetryAt = new Date(Date.now() + fallbackMs);
            await db
              .update(orders)
              .set({ nextRetryAt })
              .where(eq(orders.id, row.id));
            return;
          }

          try {
            const r = await retryFailedOrderDelivery(row.id);
            if (r.outcome === "sent" || r.outcome === "failed_exhausted" || r.outcome === "failed_will_retry") {
              retried += 1;
            }
          } catch (err) {
            console.error(`[OrderRetry] order ${row.id}:`, err);
          }
        }, { groupKey: `${row.integrationId}:${row.destinationId}` }),
      ),
    );
    await runner.runAll();
  } finally {
    runner.stop();
  }

  if (cbBlocked > 0 || cbProbed > 0) {
    console.log(
      `[OrderRetry][CB] block=${cbBlocked} probe=${cbProbed} allow=${cbAllowed} enforced=${enforced}`,
    );
  }

  console.log(
    `[OrderRetry] ${new Date().toISOString()} — examined ${due.length} due order row(s), ${retried} delivery attempt(s) completed (concurrency=${concurrency}, rate=${ratePerSecond}/s)`,
  );
  return { retried };
}

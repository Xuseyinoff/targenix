/**
 * Background retry timers (in-process):
 *
 *   1. **Per-minute order tick** — drains failed deliveries that are due
 *      (see `orderRetryScheduler`).
 *
 *   2. **Per-minute Graph retry tick** — re-enqueues leads whose Facebook
 *      Graph enrichment failed and whose `dataNextRetryAt <= NOW()` window
 *      has elapsed (see `leadGraphRetryScheduler`). Replaces the previous
 *      hourly thundering-herd retry that ignored attempts and backoff.
 *
 *   3. **Hourly stuck-pending tick** — re-dispatches leads stuck in
 *      `PENDING` for more than 10 minutes (the worker likely crashed mid-job).
 *
 * For Kubernetes / Railway, you can instead run `curl` against an admin
 * endpoint or a dedicated worker on the same schedule — example at bottom of file.
 */

import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { leads } from "../../drizzle/schema";
import { dispatchLeadProcessing } from "./leadDispatch";
import { retryDueFailedOrders } from "./orderRetryScheduler";
import { retryDueGraphErrorLeads } from "./leadGraphRetryScheduler";
import { autoPromoteExpiredCooldowns } from "./circuitBreaker";
import { log } from "./appLogger";
import { captureCritical } from "../monitoring/sentry";
import { newSchedulerTraceId, runWithRequestContext } from "../lib/requestContext";

import { envInt } from "../lib/envHelpers";

/** How often to run (ms). Default: every hour, aligned to top-of-hour. */
const RETRY_INTERVAL_MS = envInt("RETRY_INTERVAL_MS", 60 * 60 * 1000);

/** Leads stuck in PENDING longer than this are considered lost (worker was down). */
const STUCK_PENDING_THRESHOLD_MS = envInt("STUCK_PENDING_THRESHOLD_MS", 10 * 60 * 1000);

/**
 * @deprecated Use the per-minute `retryDueGraphErrorLeads` (in
 * `leadGraphRetryScheduler.ts`) which uses the same `attempts` + `nextRetryAt`
 * model as orders. Kept here as a thin shim so any external callers (CRON,
 * admin tooling) continue to work; it now just delegates with the same
 * per-minute batch size.
 */
export async function retryGraphErrorLeads(): Promise<{ retried: number }> {
  return retryDueGraphErrorLeads();
}

/**
 * Re-queue leads that are stuck in PENDING (worker was down when job ran).
 * BullMQ marks the job as failed after max retries, but the DB lead stays PENDING
 * forever — this picks them up and re-dispatches.
 */
export async function retryStuckPendingLeads(): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    await log.warn(
      "SYSTEM",
      "[RetryScheduler] DB not available, skipping stuck-pending retry run",
    );
    return { retried: 0 };
  }

  const cutoff = new Date(Date.now() - STUCK_PENDING_THRESHOLD_MS);
  const stuckLeads = await db
    .select()
    .from(leads)
    .where(and(eq(leads.dataStatus, "PENDING"), lt(leads.createdAt, cutoff)));

  if (stuckLeads.length === 0) {
    void log.info("SYSTEM", "[RetryScheduler] No stuck PENDING leads to re-queue");
    return { retried: 0 };
  }

  const toRetry = stuckLeads.slice(0, 500);
  if (stuckLeads.length > 500) {
    await log.warn(
      "SYSTEM",
      `[RetryScheduler] Stuck-pending backlog (${stuckLeads.length}), capping at 500`,
      { backlog: stuckLeads.length, cap: 500 },
    );
  }

  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 2000;

  for (let i = 0; i < toRetry.length; i += BATCH_SIZE) {
    const batch = toRetry.slice(i, i + BATCH_SIZE);
    const delayMs = (i / BATCH_SIZE) * BATCH_DELAY_MS;

    setTimeout(() => {
      for (const lead of batch) {
        void dispatchLeadProcessing({
          leadId: lead.id,
          leadgenId: lead.leadgenId,
          pageId: lead.pageId,
          formId: lead.formId,
          userId: lead.userId,
        }).catch((err: unknown) =>
          void log.error(
            "SYSTEM",
            `[RetryScheduler] dispatch failed for stuck-pending lead ${lead.id}`,
            { leadId: lead.id, error: err instanceof Error ? err.message : String(err) },
          ),
        );
      }
    }, delayMs);
  }

  void log.info(
    "SYSTEM",
    "[RetryScheduler] Re-queued stuck PENDING leads",
    {
      retried: toRetry.length,
      thresholdMinutes: STUCK_PENDING_THRESHOLD_MS / 60000,
    },
  );
  return { retried: toRetry.length };
}

/**
 * Runs graph-error lead retries + stuck-pending retries + due order retries.
 * Used by the hourly timer and by admin "retry all" tooling.
 */
export async function retryAllFailedLeads(): Promise<{ retried: number }> {
  const graph = await retryGraphErrorLeads();
  const stuck = await retryStuckPendingLeads();
  const ordersResult = await retryDueFailedOrders();
  const retried = graph.retried + stuck.retried + ordersResult.retried;
  if (retried > 0) {
    void log.info(
      "SYSTEM",
      "[RetryScheduler] Hourly job summary",
      {
        graphErrors: graph.retried,
        stuckPending: stuck.retried,
        orderDeliveries: ordersResult.retried,
      },
    );
  }
  return { retried };
}

function msUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

let hourlyTimer: ReturnType<typeof setTimeout> | null = null;
let orderTickTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Overlap guard for the per-minute order tick. Without this, a tick that
 * takes longer than ORDER_TICK_INTERVAL_MS (60s — possible under DB lock
 * contention or a slow burst of CB evaluations) would let setInterval
 * fire the NEXT tick while the previous one is still mid-loop. Result:
 * doubled claim contention on `orders.nextRetryAt`, doubled rate-limiter
 * pressure on partner APIs, and memory growth. Skipping the overlap is
 * always safe — the work the missed tick would have done is picked up
 * by the next one (rows still match `nextRetryAt <= NOW()`).
 */
let orderTickInFlight = false;

/** Per-minute tick cadence for the order-delivery retry loop. */
const ORDER_TICK_INTERVAL_MS = 60 * 1000;
/**
 * Cap on orders processed per minute tick. Picked so a 1k-order queue
 * drains in ~30 minutes and steady-state load on partner APIs stays well
 * below burst limits. Override via env when ramping up.
 */
const ORDER_TICK_BATCH = Math.max(
  1,
  Math.floor(Number(process.env.RETRY_ORDER_TICK_BATCH ?? 30)),
);

/**
 * Start the retry scheduler. Two cadences:
 *
 *   1. **Per-minute** order tick — drains the `orders.nextRetryAt <= NOW()`
 *      queue in small batches. Smooth pressure on partner APIs (no
 *      top-of-hour spike) and the CB gate gets fast feedback when a
 *      destination flips from OPEN to HALF_OPEN.
 *
 *   2. **Hourly** lead-pipeline tick — Graph error re-enrichment + stuck
 *      PENDING leads. Low-volume and OK to batch, so we keep the old
 *      cadence for these.
 *
 * Safe to call once at process boot.
 */
export function startRetryScheduler(): void {
  if (orderTickTimer !== null) return;

  // 1. Order retry tick (per-minute, small batch)
  void log.info("SYSTEM", "[RetryScheduler] Starting per-minute order tick", {
    batch: ORDER_TICK_BATCH,
  });
  orderTickTimer = setInterval(() => {
    if (orderTickInFlight) {
      void log.warn(
        "SYSTEM",
        "[RetryScheduler] skipping order tick — previous still in-flight",
      );
      return;
    }
    orderTickInFlight = true;
    const startedAt = Date.now();
    void runWithRequestContext(
      { traceId: newSchedulerTraceId("retry"), kind: "scheduler", name: "retry" },
      async () => {
        try {
          // Promote any OPEN destinations whose cooldown has elapsed BEFORE
          // claiming retries, so the next delivery (initial or retry) sees
          // HALF_OPEN and runs a probe instead of getting filed under another
          // consecutiveFailure on an already-open row. Without this step the
          // breaker can deadlock — see autoPromoteExpiredCooldowns comment.
          try {
            const db = await getDb();
            if (db) {
              const promoted = await autoPromoteExpiredCooldowns(db);
              if (promoted > 0) {
                void log.info(
                  "SYSTEM",
                  "[RetryScheduler] CB auto-promoted destinations OPEN→HALF_OPEN",
                  { promoted },
                );
              }
            }
          } catch (err) {
            await log.error(
              "SYSTEM",
              "[RetryScheduler] CB auto-promote tick failed",
              { error: err instanceof Error ? err.message : String(err) },
            );
            captureCritical(err, { tags: { scheduler: "retry", stage: "cb-auto-promote" } });
          }

          try {
            await retryDueFailedOrders({ limit: ORDER_TICK_BATCH });
          } catch (err) {
            await log.error(
              "SYSTEM",
              "[RetryScheduler] Order tick failed",
              { error: err instanceof Error ? err.message : String(err) },
            );
            captureCritical(err, { tags: { scheduler: "retry", stage: "order-tick" } });
          }

          // Graph enrichment retries piggy-back on the same per-minute tick.
          // Smooth steady-state load on Facebook (no top-of-hour spike) and the
          // policy classifier in `leadEnrichmentRetryPolicy` keeps
          // permanently-missing leadgenIds (code 100/33) out of the rotation.
          try {
            await retryDueGraphErrorLeads();
          } catch (err) {
            await log.error(
              "SYSTEM",
              "[RetryScheduler] Graph-retry tick failed",
              { error: err instanceof Error ? err.message : String(err) },
            );
            captureCritical(err, { tags: { scheduler: "retry", stage: "graph-retry" } });
          }
        } finally {
          orderTickInFlight = false;
          const durationMs = Date.now() - startedAt;
          if (durationMs > ORDER_TICK_INTERVAL_MS) {
            void log.warn(
              "SYSTEM",
              "[RetryScheduler] order tick exceeded interval",
              { durationMs, intervalMs: ORDER_TICK_INTERVAL_MS },
            );
          }
        }
      },
    );
  }, ORDER_TICK_INTERVAL_MS);
  (orderTickTimer as unknown as { unref?: () => void })?.unref?.();

  // 2. Hourly stuck-pending tick — Graph retries moved to the per-minute
  // tick (see retryDueGraphErrorLeads above), so this hourly job only
  // sweeps up leads stuck in PENDING beyond the threshold (worker crashed
  // mid-processing).
  const scheduleHourly = () => {
    const delay = msUntilNextHour();
    const nextRun = new Date(Date.now() + delay);
    void log.info("SYSTEM", "[RetryScheduler] Next hourly stuck-pending tick scheduled", {
      nextRunAt: nextRun.toISOString(),
      delayMinutes: Math.round(delay / 60000),
    });

    hourlyTimer = setTimeout(() => {
      void runWithRequestContext(
        {
          traceId: newSchedulerTraceId("retry-stuck-pending"),
          kind: "scheduler",
          name: "retry-stuck-pending",
        },
        async () => {
          const stuck = await retryStuckPendingLeads().catch((err: unknown) => {
            void log.error(
              "SYSTEM",
              "[RetryScheduler] stuck-pending tick failed",
              { error: err instanceof Error ? err.message : String(err) },
            );
            return { retried: 0 };
          });
          if (stuck.retried > 0) {
            void log.info(
              "SYSTEM",
              "[RetryScheduler] Hourly stuck-pending summary",
              { retried: stuck.retried },
            );
          }
        },
      );
      hourlyTimer = null;
      scheduleHourly();
    }, delay);
  };

  scheduleHourly();
}

export function stopRetryScheduler(): void {
  if (orderTickTimer !== null) {
    clearInterval(orderTickTimer);
    orderTickTimer = null;
  }
  if (hourlyTimer !== null) {
    clearTimeout(hourlyTimer);
    hourlyTimer = null;
  }
}

/*
 * ── External CRON (e.g. GitHub Actions, k8s CronJob) ─────────────────────────
 * POST /api/admin/.../retry-all  (with auth) — or invoke worker:
 *
 * ```yaml
 * apiVersion: batch/v1
 * kind: CronJob
 * metadata:
 *   name: targenix-order-retry
 * spec:
 *   schedule: "0 * * * *"   # every hour at :00
 *   jobTemplate:
 *     spec:
 *       template:
 *         spec:
 *           containers:
 *           - name: curl
 *             image: curlimages/curl:latest
 *             command:
 *             - curl
 *             - -X
 *             - POST
 *             - -H
 *             - "Authorization: Bearer $CRON_SECRET"
 *             - https://app.example.com/api/internal/retry-due
 * ```
 */

/**
 * Hourly background jobs (in-process timer, aligned to clock hour):
 *
 * 1. **Graph errors** — leads with dataStatus = ERROR still need a full processLead
 *    (token / Graph fetch). Capped batch + staggered dispatch.
 *
 * 2. **Failed orders** — integration routing only, max 3 attempts, 1h spacing
 *    (see orderRetryScheduler + leadService.retryFailedOrderDelivery).
 *
 * For Kubernetes / Railway, you can instead run `curl` against an admin
 * endpoint or a dedicated worker on the same schedule — example at bottom of file.
 */

import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { leads } from "../../drizzle/schema";
import { dispatchLeadProcessing } from "./leadDispatch";
import { retryDueFailedOrders } from "./orderRetryScheduler";

/** How often to run (ms). Default: every hour, aligned to top-of-hour. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** Leads stuck in PENDING longer than this are considered lost (worker was down). */
const STUCK_PENDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Re-queue leads that failed Facebook Graph enrichment (full pipeline).
 * Delivery-only failures are handled by {@link retryDueFailedOrders}, not here.
 */
export async function retryGraphErrorLeads(): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[RetryScheduler] DB not available, skipping graph-error retry run");
    return { retried: 0 };
  }

  const graphErrorLeads = await db.select().from(leads).where(eq(leads.dataStatus, "ERROR"));

  if (graphErrorLeads.length === 0) {
    console.log("[RetryScheduler] No leads with Graph errors to auto-retry");
    return { retried: 0 };
  }

  const toRetry = graphErrorLeads.slice(0, 500);
  if (graphErrorLeads.length > 500) {
    console.warn(`[RetryScheduler] Graph-error backlog (${graphErrorLeads.length}), capping at 500`);
  }

  const ids = toRetry.map((l) => l.id);
  for (const id of ids) {
    await db
      .update(leads)
      .set({ dataStatus: "PENDING", deliveryStatus: "PENDING", dataError: null })
      .where(eq(leads.id, id));
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
          console.error(`[RetryScheduler] dispatch failed for lead ${lead.id}:`, err),
        );
      }
    }, delayMs);
  }

  console.log(
    `[RetryScheduler] ${new Date().toISOString()} — queued ${toRetry.length} lead(s) with Graph errors for full reprocessing`,
  );
  return { retried: toRetry.length };
}

/**
 * Re-queue leads that are stuck in PENDING (worker was down when job ran).
 * BullMQ marks the job as failed after max retries, but the DB lead stays PENDING
 * forever — this picks them up and re-dispatches.
 */
export async function retryStuckPendingLeads(): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[RetryScheduler] DB not available, skipping stuck-pending retry run");
    return { retried: 0 };
  }

  const cutoff = new Date(Date.now() - STUCK_PENDING_THRESHOLD_MS);
  const stuckLeads = await db
    .select()
    .from(leads)
    .where(and(eq(leads.dataStatus, "PENDING"), lt(leads.createdAt, cutoff)));

  if (stuckLeads.length === 0) {
    console.log("[RetryScheduler] No stuck PENDING leads to re-queue");
    return { retried: 0 };
  }

  const toRetry = stuckLeads.slice(0, 500);
  if (stuckLeads.length > 500) {
    console.warn(`[RetryScheduler] Stuck-pending backlog (${stuckLeads.length}), capping at 500`);
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
          console.error(`[RetryScheduler] dispatch failed for stuck-pending lead ${lead.id}:`, err),
        );
      }
    }, delayMs);
  }

  console.log(
    `[RetryScheduler] ${new Date().toISOString()} — re-queued ${toRetry.length} stuck PENDING lead(s) (older than ${STUCK_PENDING_THRESHOLD_MS / 60000} min)`,
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
    console.log(
      `[RetryScheduler] Hourly job summary — graph errors: ${graph.retried}, stuck pending: ${stuck.retried}, order deliveries: ${ordersResult.retried}`,
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
  console.log(
    `[RetryScheduler] Starting per-minute order tick (batch=${ORDER_TICK_BATCH})`,
  );
  orderTickTimer = setInterval(() => {
    void retryDueFailedOrders({ limit: ORDER_TICK_BATCH }).catch((err: unknown) =>
      console.error("[RetryScheduler] Order tick failed:", err),
    );
  }, ORDER_TICK_INTERVAL_MS);
  (orderTickTimer as unknown as { unref?: () => void })?.unref?.();

  // 2. Hourly lead-pipeline tick (graph + stuck pending)
  const scheduleHourly = () => {
    const delay = msUntilNextHour();
    const nextRun = new Date(Date.now() + delay);
    console.log(
      `[RetryScheduler] Next hourly lead-pipeline tick at ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} min)`,
    );

    hourlyTimer = setTimeout(() => {
      void (async () => {
        const graph = await retryGraphErrorLeads().catch((err: unknown) => {
          console.error("[RetryScheduler] graph-error tick failed:", err);
          return { retried: 0 };
        });
        const stuck = await retryStuckPendingLeads().catch((err: unknown) => {
          console.error("[RetryScheduler] stuck-pending tick failed:", err);
          return { retried: 0 };
        });
        if (graph.retried > 0 || stuck.retried > 0) {
          console.log(
            `[RetryScheduler] Hourly lead-pipeline summary — graph errors: ${graph.retried}, stuck pending: ${stuck.retried}`,
          );
        }
      })();
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

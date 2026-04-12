/**
 * retryScheduler.ts
 *
 * Automatically retries leads with Graph errors or failed/partial delivery every hour
 * (e.g., 08:00, 09:00, 10:00, …).
 *
 * Uses a simple setInterval-based scheduler — no external dependencies required.
 * The scheduler runs in-process alongside the Express server.
 */

import { eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db";
import { leads } from "../../drizzle/schema";
import { dispatchLeadProcessing } from "./leadDispatch";

/** How often to retry (ms). Default: every hour. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Retry leads where dataStatus = ERROR or delivery is FAILED / PARTIAL.
 * Called automatically by the scheduler and can also be called manually in tests.
 */
export async function retryAllFailedLeads(): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[RetryScheduler] DB not available, skipping retry run");
    return { retried: 0 };
  }

  const failedLeads = await db
    .select()
    .from(leads)
    .where(
      or(
        eq(leads.dataStatus, "ERROR"),
        inArray(leads.deliveryStatus, ["FAILED", "PARTIAL"])
      )
    );

  if (failedLeads.length === 0) {
    console.log("[RetryScheduler] No leads to auto-retry");
    return { retried: 0 };
  }

  // Safety cap: never blast more than 500 at once. If backlog > 500,
  // something systemic broke — fix root cause, not symptoms.
  const toRetry = failedLeads.slice(0, 500);
  if (failedLeads.length > 500) {
    console.warn(`[RetryScheduler] Backlog too large (${failedLeads.length}), capping retry at 500`);
  }

  // Reset → full pipeline re-run (enrichment + routing)
  const ids = toRetry.map((l) => l.id);
  for (const id of ids) {
    await db
      .update(leads)
      .set({ dataStatus: "PENDING", deliveryStatus: "PENDING", dataError: null })
      .where(eq(leads.id, id));
  }

  // Dispatch in batches of 10, with 2s between batches — prevents API rate-limit spikes
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
          console.error(`[RetryScheduler] dispatch failed for lead ${lead.id}:`, err)
        );
      }
    }, delayMs);
  }

  console.log(
    `[RetryScheduler] ${new Date().toISOString()} — queued ${toRetry.length} lead(s) for retry in batches of ${BATCH_SIZE}`
  );
  return { retried: toRetry.length };
}

/**
 * Calculate milliseconds until the next top-of-the-hour.
 * e.g., if it's 09:47:30, returns ms until 10:00:00.
 */
function msUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the hourly retry scheduler.
 * Fires at the top of each hour (08:00, 09:00, 10:00, …).
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startRetryScheduler(): void {
  if (schedulerTimer !== null) return; // already running

  const scheduleNext = () => {
    const delay = msUntilNextHour();
    const nextRun = new Date(Date.now() + delay);
    console.log(
      `[RetryScheduler] Next auto-retry scheduled at ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} min)`
    );

    schedulerTimer = setTimeout(() => {
      void retryAllFailedLeads();
      // After firing, schedule the next hour
      schedulerTimer = null;
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

/**
 * Stop the scheduler (useful in tests).
 */
export function stopRetryScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

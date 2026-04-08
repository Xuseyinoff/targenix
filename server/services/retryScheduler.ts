/**
 * retryScheduler.ts
 *
 * Automatically retries all FAILED leads every hour at the top of the hour
 * (e.g., 08:00, 09:00, 10:00, …).
 *
 * Uses a simple setInterval-based scheduler — no external dependencies required.
 * The scheduler runs in-process alongside the Express server.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { leads } from "../../drizzle/schema";
import { dispatchLeadProcessing } from "./leadDispatch";

/** How often to retry (ms). Default: every hour. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Max leads per batch to avoid loading all into memory at once. */
const RETRY_BATCH_SIZE = 100;

/** Delay between batches (ms) to avoid thundering herd. */
const RETRY_BATCH_DELAY_MS = 5000;

/**
 * Retry all FAILED leads across all users.
 * Processes in paginated batches to avoid memory spikes and thundering herd.
 */
export async function retryAllFailedLeads(): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    console.warn("[RetryScheduler] DB not available, skipping retry run");
    return { retried: 0 };
  }

  let totalRetried = 0;
  let offset = 0;

  while (true) {
    const batch = await db
      .select()
      .from(leads)
      .where(eq(leads.status, "FAILED"))
      .limit(RETRY_BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) break;

    // Reset this batch FAILED → PENDING
    const batchIds = batch.map((l) => l.id);
    for (const id of batchIds) {
      await db.update(leads).set({ status: "PENDING" }).where(eq(leads.id, id));
    }

    // Dispatch each lead in the batch
    for (const lead of batch) {
      setImmediate(() => {
        const result = dispatchLeadProcessing({
          leadId: lead.id,
          leadgenId: lead.leadgenId,
          pageId: lead.pageId,
          formId: lead.formId,
          userId: lead.userId,
        });
        if (result && typeof result.catch === "function") {
          result.catch((err: unknown) =>
            console.error(`[RetryScheduler] lead ${lead.id} error:`, err)
          );
        }
      });
    }

    totalRetried += batch.length;
    console.log(
      `[RetryScheduler] Dispatched batch of ${batch.length} leads (total so far: ${totalRetried})`
    );

    if (batch.length < RETRY_BATCH_SIZE) break; // last batch

    // Wait before next batch to spread load
    await new Promise((resolve) => setTimeout(resolve, RETRY_BATCH_DELAY_MS));
    offset += RETRY_BATCH_SIZE;
  }

  if (totalRetried === 0) {
    console.log("[RetryScheduler] No FAILED leads to retry");
  } else {
    console.log(
      `[RetryScheduler] ${new Date().toISOString()} — retried ${totalRetried} FAILED lead(s)`
    );
  }

  return { retried: totalRetried };
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

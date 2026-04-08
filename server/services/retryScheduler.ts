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
import { leads, users } from "../../drizzle/schema";
import { processLead } from "./leadService";

/** How often to retry (ms). Default: every hour. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Retry all FAILED leads across all users.
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
    .where(eq(leads.status, "FAILED"));

  if (failedLeads.length === 0) {
    console.log("[RetryScheduler] No FAILED leads to retry");
    return { retried: 0 };
  }

  // Reset all FAILED → RECEIVED in one query
  await db
    .update(leads)
    .set({ status: "RECEIVED" })
    .where(eq(leads.status, "FAILED"));

  // Re-process each lead asynchronously
  for (const lead of failedLeads) {
    setImmediate(() => {
      const result = processLead({
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

  console.log(
    `[RetryScheduler] ${new Date().toISOString()} — retrying ${failedLeads.length} FAILED lead(s)`
  );
  return { retried: failedLeads.length };
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

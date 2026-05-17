/**
 * destinationFlushScheduler.ts — per-minute tick that drives per-destination
 * daily pause scheduling.
 *
 * Yuboraman parity sprint, PR 4/4. Phase A established the table + stub
 * scheduler; Phase B turned the stubs into real dispatch by delegating
 * to `destinationPendingQueue`. This file now stays focused on tick
 * orchestration: pause/start transitions live here; flush, TTL, and
 * orphan cleanup are one-line calls into the queue module.
 *
 * Three jobs run on each tick:
 *
 *   1. **Pause-state transitions.** For each row in destination_schedules,
 *      compute the current hour in that row's `timezone`. If we just
 *      entered the row's `pauseHour`, set `isPausedNow = true`. If we
 *      just entered its `startHour`, set `isPausedNow = false`. "Just
 *      entered" is tracked via an in-memory map keyed on the schedule id
 *      — on worker restart the map resets, which is harmless because
 *      both transitions are idempotent against the current value.
 *
 *   2. **Flush at sendHour.** For each schedule whose `sendHour` matches
 *      the current hour, call `flushPendingForDestination` (Phase B) to
 *      atomically claim every undelivered row and call `dispatchDelivery`
 *      for each. Failures roll back the claim so the next tick retries.
 *
 *   3. **TTL stale-pending.** Any undelivered row older than 24h is
 *      force-flushed via `flushStalePendingLeads` so a misconfigured
 *      schedule cannot blackhole leads indefinitely.
 *
 *   4. **Orphan cleanup.** Rows whose destination has been hard-deleted
 *      are marked `deliveredAt = NOW(), deliveryError = "destination_deleted"`
 *      so the active set stays clean.
 *
 * Cycle note: this file is imported by destinationPendingQueue.ts for
 * `currentHourInTimezone`, and imports flush helpers back from the
 * queue. ESM resolves the cycle at runtime because both bindings are
 * only accessed inside functions (never at module-init time).
 *
 * Overlap protection: setInterval cadence + module-level `inFlight` flag
 * (same pattern as retryScheduler.ts). Reset in `finally` so a thrown
 * error can't wedge the scheduler. Sentry escalation in the catch path
 * so a silent failure flows to telemetry.
 *
 * Shutdown: `stopDestinationFlushScheduler()` clears the interval and
 * resets module-level state. Wired into workers/run.ts shutdown before
 * flushSentry (same pattern as stopOAuthStateCleanupScheduler).
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { destinationSchedules } from "../../drizzle/schema";
import { log } from "./appLogger";
import { captureCritical } from "../monitoring/sentry";
import {
  flushPendingForDestination,
  flushStalePendingLeads,
  cleanupOrphanedPending,
} from "./destinationPendingQueue";

/** Cadence — every 60s. Hour-grain scheduling doesn't need finer. */
const TICK_INTERVAL_MS = 60 * 1000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/**
 * lastEvaluatedHour[scheduleId] = the hour (in that schedule's timezone)
 * at which we last processed transitions for it. A tick fires the
 * transition only when the current hour differs from the stored value —
 * prevents the per-minute tick from re-firing 60× per hour.
 *
 * In-memory: worker restart resets the map. Re-firing a transition after
 * restart is safe because both `isPausedNow := true` (at pauseHour) and
 * `isPausedNow := false` (at startHour) are idempotent against the row's
 * current value. A re-fired sendHour flush is also safe — the atomic
 * claim inside flushPendingForDestination ensures every pending row is
 * dispatched at most once.
 */
const lastEvaluatedHour = new Map<number, number>();

/**
 * Compute the current hour-of-day (0-23) in the given IANA timezone using
 * the platform Intl API — no luxon/date-fns-tz dependency. Falls back to
 * UTC if the timezone string is invalid (logged once per offending value
 * to avoid spamming on every tick).
 */
const invalidTzLogged = new Set<string>();
export function currentHourInTimezone(timezone: string, now: Date = new Date()): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
    // Intl returns "24" for midnight in some hour12=false locales — normalise.
    const hour = Number.parseInt(hourPart, 10) % 24;
    return Number.isFinite(hour) ? hour : 0;
  } catch (err) {
    if (!invalidTzLogged.has(timezone)) {
      invalidTzLogged.add(timezone);
      void log.warn("SYSTEM", "[DestFlushScheduler] invalid timezone, falling back to UTC", {
        timezone,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return now.getUTCHours();
  }
}

/**
 * Execute a single tick — exported so the test suite can drive it
 * deterministically and the worker doesn't have to advance fake timers.
 */
export async function runFlushTick(now: Date = new Date()): Promise<{
  schedulesEvaluated: number;
  transitionsApplied: number;
  sendHoursTriggered: number;
  flushAttempted: number;
  flushSucceeded: number;
  flushFailed: number;
  staleDestinations: number;
  orphansCleaned: number;
}> {
  const db = await getDb();
  if (!db) {
    void log.warn("SYSTEM", "[DestFlushScheduler] DB not available, skipping tick");
    return {
      schedulesEvaluated: 0,
      transitionsApplied: 0,
      sendHoursTriggered: 0,
      flushAttempted: 0,
      flushSucceeded: 0,
      flushFailed: 0,
      staleDestinations: 0,
      orphansCleaned: 0,
    };
  }

  const schedules = await db.select().from(destinationSchedules);

  let transitionsApplied = 0;
  let sendHoursTriggered = 0;
  let flushAttempted = 0;
  let flushSucceeded = 0;
  let flushFailed = 0;

  for (const sched of schedules) {
    const tzHour = currentHourInTimezone(sched.timezone, now);
    const previousHour = lastEvaluatedHour.get(sched.id);
    const justEnteredHour = previousHour !== tzHour;

    if (!justEnteredHour) continue;

    // Pause transition.
    if (sched.pauseHour !== null && sched.pauseHour === tzHour && !sched.isPausedNow) {
      await db
        .update(destinationSchedules)
        .set({ isPausedNow: true })
        .where(eq(destinationSchedules.id, sched.id));
      transitionsApplied++;
      void log.info("SYSTEM", "[DestFlushScheduler] pause transition fired", {
        scheduleId: sched.id,
        destinationId: sched.destinationId,
        userId: sched.userId,
        timezone: sched.timezone,
        hour: tzHour,
      });
    }

    // Start transition. Triggers an immediate flush — same semantics as
    // a manual startAll, since the destination is now accepting leads.
    if (sched.startHour !== null && sched.startHour === tzHour && sched.isPausedNow) {
      await db
        .update(destinationSchedules)
        .set({ isPausedNow: false })
        .where(eq(destinationSchedules.id, sched.id));
      transitionsApplied++;
      void log.info("SYSTEM", "[DestFlushScheduler] start transition fired", {
        scheduleId: sched.id,
        destinationId: sched.destinationId,
        userId: sched.userId,
        timezone: sched.timezone,
        hour: tzHour,
      });
      const startFlush = await flushPendingForDestination(db, sched.destinationId);
      flushAttempted += startFlush.attempted;
      flushSucceeded += startFlush.succeeded;
      flushFailed += startFlush.failed;
    }

    // Send-hour flush (Phase B real dispatch).
    if (sched.sendHour !== null && sched.sendHour === tzHour) {
      sendHoursTriggered++;
      const sendFlush = await flushPendingForDestination(db, sched.destinationId);
      flushAttempted += sendFlush.attempted;
      flushSucceeded += sendFlush.succeeded;
      flushFailed += sendFlush.failed;
    }

    lastEvaluatedHour.set(sched.id, tzHour);
  }

  // TTL force-send for anything older than 24h regardless of sendHour.
  const stale = await flushStalePendingLeads(db, now);
  flushAttempted += stale.attempted;
  flushSucceeded += stale.succeeded;
  flushFailed += stale.failed;

  // Mark orphaned pending rows (destination hard-deleted) so the active
  // set stays clean and the flush loop doesn't re-touch them next tick.
  const orphans = await cleanupOrphanedPending(db);

  return {
    schedulesEvaluated: schedules.length,
    transitionsApplied,
    sendHoursTriggered,
    flushAttempted,
    flushSucceeded,
    flushFailed,
    staleDestinations: stale.destinations,
    orphansCleaned: orphans.cleaned,
  };
}

/** Start the per-minute tick. Idempotent — safe to call once at process boot. */
export function startDestinationFlushScheduler(): void {
  if (tickTimer !== null) return;

  void log.info("SYSTEM", "[DestFlushScheduler] starting per-minute tick", {
    intervalMs: TICK_INTERVAL_MS,
  });

  tickTimer = setInterval(() => {
    if (inFlight) {
      void log.warn("SYSTEM", "[DestFlushScheduler] skipping tick — previous still in-flight");
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    void (async () => {
      try {
        await runFlushTick();
      } catch (err) {
        await log.error("SYSTEM", "[DestFlushScheduler] tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        captureCritical(err, { tags: { scheduler: "destinationFlush" } });
      } finally {
        inFlight = false;
        const durationMs = Date.now() - startedAt;
        if (durationMs > TICK_INTERVAL_MS) {
          void log.warn("SYSTEM", "[DestFlushScheduler] tick exceeded interval", {
            durationMs,
            intervalMs: TICK_INTERVAL_MS,
          });
        }
      }
    })();
  }, TICK_INTERVAL_MS);
  (tickTimer as unknown as { unref?: () => void })?.unref?.();
}

/**
 * Cancel the pending tick and reset module state. Idempotent. Wired into
 * the worker SIGTERM/SIGINT handler so a deploy doesn't leave a dangling
 * setInterval running against a closing DB.
 */
export function stopDestinationFlushScheduler(): void {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  inFlight = false;
  lastEvaluatedHour.clear();
}

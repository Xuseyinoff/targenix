/**
 * metricSnapshotScheduler — periodic capture of in-process counters and
 * DB-side gauges to the `metric_snapshots` table. Roadmap #7 phase C.
 *
 * Why this exists: the in-memory counters in `monitoring/metrics.ts`
 * (failedOrdersCount, oauthErrorsCount) reset on every process restart,
 * and DB-side gauges (failed_orders_db, retry_queue_size) only had
 * console.log output behind an env flag. Operators had no way to graph
 * trends or correlate a spike with an incident timeline.
 *
 * Each capture:
 *   1. Reads & resets the in-process counters atomically (see
 *      `readAndResetCounters`), so every persisted "counter" row is a
 *      delta over the interval — clean to plot, immune to restarts.
 *   2. Queries the two DB gauges (failed_orders_db, retry_queue_size).
 *   3. Inserts one row per metric.
 *
 * Best-effort: failures are logged via appLogger; the next interval
 * tries again. The reset-then-fail-to-write case is the worst outcome
 * — we lose the in-interval counter delta — but the impact is bounded
 * to one snapshot interval (default 5 minutes).
 *
 * Like every other scheduler in this codebase, each tick runs inside a
 * request context so its log lines share a `sched-metrics-*` trace id.
 */

import type { DbClient } from "../db";
import { getDb } from "../db";
import { metricSnapshots } from "../../drizzle/schema";
import {
  getFailedOrdersCountDb,
  getRetryQueueSize,
  readAndResetCounters,
} from "../monitoring/metrics";
import { log } from "./appLogger";
import { envInt } from "../lib/envHelpers";
import { newSchedulerTraceId, runWithRequestContext } from "../lib/requestContext";

const SNAPSHOT_INTERVAL_MS = envInt("METRIC_SNAPSHOT_INTERVAL_MS", 5 * 60 * 1000);

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

/**
 * Capture one row per metric. Exported separately from the scheduler
 * so admin tooling can force a snapshot on demand (e.g. before/after a
 * deploy) without waiting for the next tick.
 */
export async function captureMetricSnapshot(db: DbClient): Promise<void> {
  const { failedOrders, oauthErrors } = readAndResetCounters();
  let failedOrdersDb = 0;
  let retryQueue = 0;
  try {
    [failedOrdersDb, retryQueue] = await Promise.all([
      getFailedOrdersCountDb(db),
      getRetryQueueSize(db),
    ]);
  } catch (err) {
    void log.warn(
      "SYSTEM",
      "[MetricSnapshot] gauge read failed — recording counters only",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  const rows = [
    { metric: "failed_orders",    kind: "counter", value: failedOrders },
    { metric: "oauth_errors",     kind: "counter", value: oauthErrors },
    { metric: "failed_orders_db", kind: "gauge",   value: failedOrdersDb },
    { metric: "retry_queue_size", kind: "gauge",   value: retryQueue },
  ];

  try {
    await db.insert(metricSnapshots).values(rows);
    void log.info("SYSTEM", "[MetricSnapshot] captured", {
      failedOrders,
      oauthErrors,
      failedOrdersDb,
      retryQueue,
    });
  } catch (err) {
    void log.error(
      "SYSTEM",
      "[MetricSnapshot] insert failed — interval deltas lost",
      {
        error: err instanceof Error ? err.message : String(err),
        // Surface the values that would have been recorded so the data
        // isn't fully lost — an operator can grep the log and reconstruct.
        failedOrders,
        oauthErrors,
        failedOrdersDb,
        retryQueue,
      },
    );
  }
}

export function startMetricSnapshotScheduler(): void {
  if (_timer !== null) return; // idempotent
  void log.info("SYSTEM", "[MetricSnapshot] Starting", {
    intervalMinutes: SNAPSHOT_INTERVAL_MS / 60000,
  });

  _timer = setInterval(() => {
    // Overlap guard — without it, a slow gauge read (failed_orders_db can
    // span several seconds under load) lets a second tick start before the
    // first finishes, doubling DB+heap pressure during the 5-min cycle.
    // Matches the pattern used by connectionHealth, insightsRollup, fxRate.
    if (_running) {
      void log.info("SYSTEM", "[MetricSnapshot] Skipping — previous tick still running");
      return;
    }
    _running = true;
    void runWithRequestContext(
      {
        traceId: newSchedulerTraceId("metrics"),
        kind: "scheduler",
        name: "metrics",
      },
      async () => {
        try {
          const db = await getDb();
          if (!db) {
            void log.warn("SYSTEM", "[MetricSnapshot] DB unavailable — skipping tick");
            return;
          }
          await captureMetricSnapshot(db);
        } catch (err) {
          void log.error(
            "SYSTEM",
            "[MetricSnapshot] tick failed",
            { error: err instanceof Error ? err.message : String(err) },
          );
        } finally {
          _running = false;
        }
      },
    );
  }, SNAPSHOT_INTERVAL_MS);
  (_timer as unknown as { unref?: () => void })?.unref?.();
}

export function stopMetricSnapshotScheduler(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * connectionHealthScheduler — Sprint 5 / Item 5.3.
 *
 * Periodically pings every connection whose `lastVerifiedAt` is older than
 * the configured staleness threshold. Status transitions are persisted via
 * `verifyConnectionHealth` (which also writes `connection_health_logs` and
 * `connection_events` rows), so the /overview attention banner (Sprint
 * 2.2) and the Connections page light up automatically — users see
 * expired/error connections before deliveries start failing.
 *
 * Design notes:
 *   • Stale threshold: 1 hour. The /connections page invalidates this on
 *     every manual verify so a user fix lands instantly; the sweep is for
 *     unattended drift.
 *   • Batch + rate-limit: same shape as `orderRetryScheduler` — concurrency
 *     of 5 and 10 req/sec by default keeps probe traffic well under any
 *     upstream rate limit (Google Sheets / Telegram each see at most one
 *     ping per hour per connection from us).
 *   • Multi-worker safety: the SELECT is unlocked, but the per-connection
 *     update inside `verifyConnectionHealth` clears `lastVerifiedAt` so a
 *     parallel sweep cannot re-pick the same row within a few ms. For
 *     stricter exclusion we can later switch to FOR UPDATE SKIP LOCKED
 *     (Sprint 1 pattern) once the sweep volume justifies it.
 */

import { and, eq, lt, isNull, or } from "drizzle-orm";
import { connections } from "../../drizzle/schema";
import { getDb } from "../db";
import { verifyConnectionHealth } from "./connectionHealthService";
import { log } from "./appLogger";

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw != null ? parseInt(String(raw).trim(), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How stale a connection must be before the sweep re-probes it. */
const STALE_THRESHOLD_MS = envInt("CONN_HEALTH_STALE_MS", 60 * 60 * 1000);
/** How often the sweep loop wakes up. */
const SWEEP_INTERVAL_MS = envInt("CONN_HEALTH_SWEEP_INTERVAL_MS", 10 * 60 * 1000);
/** Connections probed per sweep cycle. Keeps each cycle short. */
const SWEEP_BATCH = envInt("CONN_HEALTH_BATCH", 100);
/** Concurrent in-flight probes. Bounded to avoid hammering upstream APIs. */
const SWEEP_CONCURRENCY = envInt("CONN_HEALTH_CONCURRENCY", 5);

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;

export async function runConnectionHealthSweep(): Promise<{ checked: number }> {
  if (_running) {
    console.log("[ConnectionHealth] Skipping — previous sweep still in progress");
    return { checked: 0 };
  }
  _running = true;
  try {
    const db = await getDb();
    if (!db) {
      console.warn("[ConnectionHealth] DB unavailable — skipping sweep");
      return { checked: 0 };
    }

    const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);
    const due = await db
      .select({ id: connections.id, userId: connections.userId })
      .from(connections)
      .where(
        and(
          // Include rows that have never been verified.
          or(
            isNull(connections.lastVerifiedAt),
            lt(connections.lastVerifiedAt, staleBefore),
          ),
          // Skip already-revoked rows — they can't recover until the user
          // manually re-attaches, and probing them just produces noise.
          eq(connections.status, "active"),
        ),
      )
      .limit(SWEEP_BATCH);

    if (due.length === 0) {
      return { checked: 0 };
    }

    console.log(`[ConnectionHealth] Sweeping ${due.length} connection(s)`);
    let checked = 0;
    // Simple bounded concurrency — N workers draining a shared queue. Each
    // worker catches its own per-connection errors so they never escape;
    // `Promise.allSettled` is the outer guard against any unexpected throw
    // outside that inner try/catch (e.g. a future refactor that drops it,
    // or an error inside log.warn itself). Without allSettled, one
    // unexpected throw would reject the whole `await`, leak the error into
    // an unhandled rejection, and skip the `checked=N` summary log.
    const queue = [...due];
    const work = async () => {
      while (queue.length > 0) {
        const c = queue.shift();
        if (!c) break;
        try {
          await verifyConnectionHealth(db, c.id, c.userId);
          checked++;
        } catch (err) {
          void log.warn(
            "CONNECTIONS",
            "Health sweep failed for connection",
            { connectionId: c.id, error: err instanceof Error ? err.message : String(err) },
            null,
            null,
            c.userId,
          );
        }
      }
    };
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(SWEEP_CONCURRENCY, due.length); i++) {
      workers.push(work());
    }
    const results = await Promise.allSettled(workers);
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length > 0) {
      for (const r of rejected as Array<PromiseRejectedResult>) {
        void log.error(
          "CONNECTIONS",
          "Health sweep worker rejected unexpectedly",
          { error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
          null,
          null,
          null,
        );
      }
    }

    console.log(`[ConnectionHealth] Sweep done — checked=${checked}`);
    return { checked };
  } finally {
    _running = false;
  }
}

function scheduleNext(): void {
  _timer = setTimeout(() => {
    void runConnectionHealthSweep().finally(() => {
      _timer = null;
      scheduleNext();
    });
  }, SWEEP_INTERVAL_MS);
}

export function startConnectionHealthScheduler(): void {
  if (_timer !== null) return; // idempotent
  console.log(
    `[ConnectionHealth] Starting — stale=${STALE_THRESHOLD_MS / 1000 / 60}min, sweep every ${SWEEP_INTERVAL_MS / 1000 / 60}min, batch=${SWEEP_BATCH}, concurrency=${SWEEP_CONCURRENCY}`,
  );
  // Stagger the first run so it doesn't compete with boot-time work.
  _timer = setTimeout(() => {
    void runConnectionHealthSweep().finally(() => {
      _timer = null;
      scheduleNext();
    });
  }, 2 * 60 * 1000);
}

export function stopConnectionHealthScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}

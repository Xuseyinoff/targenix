/**
 * Per-destination Circuit Breaker — Phase 0 (Shadow Mode).
 *
 * Two public entry points:
 *
 *   - `recordOutcome(db, params)` — call after every delivery attempt
 *     (success or failure). Updates window counters, streak counters, and
 *     transitions CLOSED → OPEN when a policy threshold is crossed, or
 *     HALF_OPEN → CLOSED/OPEN based on probe outcome. Idempotent w.r.t. a
 *     single (orderId, attempt) — caller wires it after the persist update.
 *
 *   - `evaluateClaim(db, params)` — call BEFORE dispatching a claimed order.
 *     Returns the decision the breaker would make: `allow` / `block` / `probe`.
 *     In Phase 0 callers MUST always proceed; the decision is logged as a
 *     `shadow_*` event for offline analysis. Enforcement lands in Phase 1.
 *
 * State machine
 * -------------
 *      ┌──────────────┐  consecutiveFailures ≥ trip       ┌──────────┐
 *      │   CLOSED     │ ──────────────────────────────▶   │   OPEN   │
 *      │              │  OR window-ratio breach           │          │
 *      └──────────────┘                                   └─────┬────┘
 *              ▲                                                │ cooldownUntil ≤ now
 *              │ probesToClose successes                        ▼
 *              │                                          ┌──────────────┐
 *              └──────────────────────────────────────────┤  HALF_OPEN   │
 *                                                         │              │
 *                  ┌──── probe failure ────────────────── │              │
 *                  │                                      └──────────────┘
 *                  ▼
 *              OPEN (cooldownLevel + 1)
 *
 * Concurrency
 * -----------
 * The row is upserted on first contact via INSERT ... ON DUPLICATE KEY UPDATE.
 * Subsequent updates use `UPDATE WHERE updatedAt = previousUpdatedAt` style is
 * not necessary in Phase 0 — we accept brief counter races because the breaker
 * doesn't enforce yet. Phase 1 will add `FOR UPDATE` locking to the read-eval
 * cycle. The event log is append-only so concurrent writes can't conflict.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../db";
import { integrationHealth, integrationHealthEvents } from "../../drizzle/schema";
import {
  CIRCUIT_POLICY,
  cooldownMsForLevel,
  getPolicy,
  isMaxLevel,
  type CircuitErrorClass,
  type CircuitPolicy,
} from "../lib/circuitPolicy";
import type { DeliveryErrorType } from "../lib/orderRetryPolicy";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type Decision = "allow" | "block" | "probe";

export type RecordOutcomeParams = {
  integrationId: number;
  destinationId: number;
  /**
   * `destinations.appKey` for this destination. When provided we cache it
   * on the row so `evaluateClaim` can answer "any sibling of this app
   * currently OPEN?" without joining through integration_routes and
   * destinations on every claim. Safe to omit — callers without the
   * value just skip per-app pooling for this outcome.
   */
  appKey?: string | null;
  success: boolean;
  errorType?: DeliveryErrorType | null;
  errorMessage?: string | null;
  /** Optional context for the event log row (orderId, attempts, retryAfter, …). */
  metadata?: Record<string, unknown>;
  /** Override "now" for deterministic tests. */
  now?: Date;
};

export type RecordOutcomeResult = {
  fromState: CircuitState;
  toState: CircuitState;
  transitioned: boolean;
  reason: string | null;
};

export type EvaluateClaimParams = {
  integrationId: number;
  destinationId: number;
  /**
   * Optional appKey override. When omitted, evaluateClaim reads it from the
   * row's cached `appKey` column. Callers can pass it explicitly to override
   * (e.g. for newly-created destinations whose row doesn't exist yet).
   */
  appKey?: string | null;
  now?: Date;
};

export type EvaluateClaimResult = {
  decision: Decision;
  state: CircuitState;
  reason: string;
  cooldownUntil: Date | null;
  manualLock: "OPEN" | "CLOSED" | null;
};

// ─── Internal helpers ──────────────────────────────────────────────────────

function classify(errorType: DeliveryErrorType | null | undefined): CircuitErrorClass {
  return errorType ?? "unknown";
}

type HealthRow = typeof integrationHealth.$inferSelect & {
  /**
   * Server-side computed `cooldownUntil <= NOW()`. We don't trust JS-side Date
   * comparison because mysql2 + pooled connections can return TIMESTAMPs in
   * different session timezones depending on which connection answered — the
   * absolute moment is right, but the Date parsed on the client may not be.
   * Doing the comparison in SQL avoids the entire client-timezone class of
   * bugs.
   */
  cooldownExpired: boolean;
};

async function loadRow(
  db: DbClient,
  integrationId: number,
  destinationId: number,
): Promise<HealthRow | null> {
  const rows = (await db.execute(sql`
    SELECT
      id, integrationId, destinationId, appKey, state,
      windowStartedAt, windowFailures, windowSuccesses,
      consecutiveFailures, consecutiveSuccesses,
      openedAt, cooldownUntil, cooldownLevel,
      lastErrorType, lastErrorMessage, lastTripReason,
      halfOpenAttempts, halfOpenSuccesses,
      manualLock, manualLockSetBy, manualLockReason, manualLockSetAt,
      createdAt, updatedAt,
      (cooldownUntil IS NOT NULL AND cooldownUntil <= NOW()) AS cooldownExpired
    FROM integration_health
    WHERE integrationId = ${integrationId} AND destinationId = ${destinationId}
    LIMIT 1
  `)) as unknown as [Array<Record<string, unknown>>, unknown];
  const raw = rows[0]?.[0];
  if (!raw) return null;

  // Raw mysql2 queries return TIMESTAMP columns as strings, BOOLEAN exprs as
  // 0/1 numbers, and so on — coerce here so downstream callers can rely on
  // the same shape as Drizzle's typed select.
  const toDate = (v: unknown): Date | null => {
    if (v == null) return null;
    if (v instanceof Date) return v;
    // mysql2 string format: "YYYY-MM-DD HH:MM:SS" — treat as UTC (the server
    // stores all TIMESTAMPs in UTC internally; we just need a consistent
    // absolute moment, not a wall-clock time).
    if (typeof v === "string") return new Date(v.replace(" ", "T") + "Z");
    return null;
  };
  return {
    ...(raw as unknown as HealthRow),
    windowStartedAt:  toDate(raw.windowStartedAt),
    openedAt:         toDate(raw.openedAt),
    cooldownUntil:    toDate(raw.cooldownUntil),
    manualLockSetAt:  toDate(raw.manualLockSetAt),
    createdAt:        toDate(raw.createdAt) as Date,
    updatedAt:        toDate(raw.updatedAt) as Date,
    cooldownExpired:  Number(raw.cooldownExpired) === 1,
  };
}

// ── Throttled Telegram alerts ──────────────────────────────────────────────
// Optional: set CB_ALERT_TELEGRAM_CHAT_ID to a chat id (or @channelname) to
// receive a DM each time a circuit-breaker transitions. Unset = silent (the
// audit log in integration_health_events is still kept).
//
// In-memory dedup: at most one alert per (integrationId, destinationId,
// eventType) per ALERT_THROTTLE_MS. The map is bounded by tearing entries
// older than the window on each insert.
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
const lastAlertSentAt = new Map<string, number>();

function shouldAlert(integrationId: number, destinationId: number, eventType: string): boolean {
  const chat = process.env.CB_ALERT_TELEGRAM_CHAT_ID?.trim();
  if (!chat) return false;
  const key = `${integrationId}:${destinationId}:${eventType}`;
  const now = Date.now();
  // GC stale entries
  if (lastAlertSentAt.size > 200) {
    lastAlertSentAt.forEach((t, k) => {
      if (now - t > ALERT_THROTTLE_MS) lastAlertSentAt.delete(k);
    });
  }
  const last = lastAlertSentAt.get(key);
  if (last != null && now - last < ALERT_THROTTLE_MS) return false;
  lastAlertSentAt.set(key, now);
  return true;
}

async function sendAlert(params: {
  integrationId: number;
  destinationId: number;
  eventType: string;
  fromState?: CircuitState | null;
  toState?: CircuitState | null;
  reason?: string | null;
  errorType?: string | null;
}): Promise<void> {
  const chat = process.env.CB_ALERT_TELEGRAM_CHAT_ID?.trim();
  if (!chat) return;
  if (!shouldAlert(params.integrationId, params.destinationId, params.eventType)) return;

  const emoji =
    params.eventType === "opened"
      ? "🚨"
      : params.eventType === "half_opened"
        ? "🟡"
        : params.eventType === "closed"
          ? "✅"
          : params.eventType === "probe_failed"
            ? "🔁"
            : "ℹ️";
  const lines = [
    `${emoji} <b>Circuit Breaker — ${params.eventType}</b>`,
    `Integration: <code>${params.integrationId}</code>` +
      (params.destinationId ? ` · Destination: <code>${params.destinationId}</code>` : ""),
    params.fromState && params.toState ? `State: ${params.fromState} → <b>${params.toState}</b>` : null,
    params.errorType ? `Error type: <code>${params.errorType}</code>` : null,
    params.reason ? `Reason: ${params.reason}` : null,
  ].filter(Boolean);
  try {
    await sendTelegramMessage(chat, lines.join("\n"), "HTML");
  } catch (err) {
    console.error("[CircuitBreaker] alert send failed:", err);
  }
}

// Events that warrant a Telegram alert (skip noisy shadow_* entries).
const ALERT_EVENT_TYPES = new Set([
  "opened",
  "half_opened",
  "closed",
  "probe_failed",
  "manual_open",
  "manual_close",
]);

async function appendEvent(
  db: DbClient,
  params: {
    integrationId: number;
    destinationId: number;
    eventType: string;
    fromState?: CircuitState | null;
    toState?: CircuitState | null;
    reason?: string | null;
    errorType?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(integrationHealthEvents).values({
      integrationId: params.integrationId,
      destinationId: params.destinationId,
      eventType: params.eventType,
      fromState: params.fromState ?? null,
      toState: params.toState ?? null,
      reason: params.reason ?? null,
      errorType: params.errorType ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    // Audit log failure must never break delivery — log & continue.
    console.error("[CircuitBreaker] failed to append event:", err);
  }

  if (ALERT_EVENT_TYPES.has(params.eventType)) {
    void sendAlert({
      integrationId: params.integrationId,
      destinationId: params.destinationId,
      eventType: params.eventType,
      fromState: params.fromState ?? null,
      toState: params.toState ?? null,
      reason: params.reason ?? null,
      errorType: params.errorType ?? null,
    });
  }
}

/**
 * Tumbling-window reset: if the window has expired, zero the counters and
 * reset windowStartedAt to `now`. Returns the windowed counters that should
 * be persisted (caller stitches them into the UPDATE payload).
 */
function rollWindow(
  row: HealthRow | null,
  policy: CircuitPolicy,
  now: Date,
  delta: { failure: number; success: number },
): { windowStartedAt: Date; windowFailures: number; windowSuccesses: number } {
  const startedAt = row?.windowStartedAt ?? null;
  const ageMs = startedAt ? now.getTime() - startedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!startedAt || ageMs > policy.windowMs) {
    return {
      windowStartedAt: now,
      windowFailures: delta.failure,
      windowSuccesses: delta.success,
    };
  }
  return {
    windowStartedAt: startedAt,
    windowFailures: (row?.windowFailures ?? 0) + delta.failure,
    windowSuccesses: (row?.windowSuccesses ?? 0) + delta.success,
  };
}

function shouldTrip(
  policy: CircuitPolicy,
  consecutiveFailures: number,
  windowFailures: number,
  windowSuccesses: number,
): { trip: true; reason: string } | { trip: false } {
  if (consecutiveFailures >= policy.consecutiveTrip) {
    return { trip: true, reason: `${consecutiveFailures} consecutive failures` };
  }
  const total = windowFailures + windowSuccesses;
  if (total >= policy.windowMinSamples) {
    const ratio = windowFailures / total;
    if (ratio >= policy.windowFailureRatio) {
      return {
        trip: true,
        reason: `${Math.round(ratio * 100)}% failure rate over last ${total} samples`,
      };
    }
  }
  return { trip: false };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Update breaker state after a delivery attempt. Returns the resulting state
 * transition (caller can wire alerts off `transitioned === true`).
 *
 * Validation errors are recorded as outcomes for visibility but the
 * `validation` policy is engineered to never trip — the breaker is the wrong
 * tool for "this single order's payload is malformed".
 */
export async function recordOutcome(
  db: DbClient,
  params: RecordOutcomeParams,
): Promise<RecordOutcomeResult> {
  const now = params.now ?? new Date();
  const klass = classify(params.errorType);
  const policy = getPolicy(params.errorType ?? null);
  const { integrationId, destinationId, success } = params;

  const existing = await loadRow(db, integrationId, destinationId);

  // First sighting of this (integrationId, destinationId) — INSERT a baseline
  // CLOSED row carrying this outcome's counters and return. We accept that a
  // concurrent first-writer race may lose at most one counter increment: that
  // window is one tick of one destination's lifetime, and the row exists from
  // here on so subsequent outcomes follow the normal UPDATE path.
  //
  // ON DUPLICATE KEY UPDATE keeps the INSERT idempotent: under a race the
  // second writer's INSERT becomes a no-op update of `updatedAt` instead of
  // an error. We don't recurse here because for the no-race case (the common
  // path) `existing` is null and `reloaded` is the row WE just inserted —
  // recursing would double-count this outcome.
  if (!existing) {
    // Single-failure trip path (e.g. rate_limit, consecutiveTrip=1) must
    // still fire on the very first contact — otherwise a 429 wouldn't open
    // the breaker until the second request. Same logic applies if window
    // policy would trip with one sample (rate_limit's windowMinSamples=1).
    const failureDelta = success ? 0 : 1;
    const successDelta = success ? 1 : 0;
    const trip = shouldTrip(policy, failureDelta, failureDelta, successDelta);

    if (!success && trip.trip) {
      const cooldownUntil = new Date(now.getTime() + cooldownMsForLevel(policy, 0));
      await db
        .insert(integrationHealth)
        .values({
          integrationId,
          destinationId,
          appKey: params.appKey ?? null,
          state: "OPEN",
          windowStartedAt: now,
          windowFailures: 1,
          windowSuccesses: 0,
          consecutiveFailures: 1,
          consecutiveSuccesses: 0,
          openedAt: now,
          cooldownUntil,
          cooldownLevel: 0,
          lastErrorType: klass,
          lastErrorMessage: (params.errorMessage ?? "").slice(0, 500) || null,
          lastTripReason: trip.reason.slice(0, 64),
        })
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
      await appendEvent(db, {
        integrationId,
        destinationId,
        eventType: "opened",
        fromState: "CLOSED",
        toState: "OPEN",
        reason: trip.reason,
        errorType: klass,
        metadata: { ...(params.metadata ?? {}), firstFailureTrip: true },
      });
      return { fromState: "CLOSED", toState: "OPEN", transitioned: true, reason: trip.reason };
    }

    await db
      .insert(integrationHealth)
      .values({
        integrationId,
        destinationId,
        appKey: params.appKey ?? null,
        state: "CLOSED",
        windowStartedAt: now,
        windowFailures: failureDelta,
        windowSuccesses: successDelta,
        consecutiveFailures: failureDelta,
        consecutiveSuccesses: successDelta,
      })
      .onDuplicateKeyUpdate({ set: { updatedAt: now } });
    return { fromState: "CLOSED", toState: "CLOSED", transitioned: false, reason: null };
  }

  const fromState = existing.state as CircuitState;
  const window = rollWindow(existing, policy, now, {
    failure: success ? 0 : 1,
    success: success ? 1 : 0,
  });
  const consecutiveFailures = success ? 0 : existing.consecutiveFailures + 1;
  const consecutiveSuccesses = success ? existing.consecutiveSuccesses + 1 : 0;

  // ── HALF_OPEN: probe outcome decides next state ──
  if (fromState === "HALF_OPEN") {
    const halfOpenAttempts = existing.halfOpenAttempts + 1;
    const halfOpenSuccesses = existing.halfOpenSuccesses + (success ? 1 : 0);

    if (success && halfOpenSuccesses >= policy.probesToClose) {
      // Probe(s) passed — close the breaker, reset everything.
      await db
        .update(integrationHealth)
        .set({
          state: "CLOSED",
          consecutiveFailures: 0,
          consecutiveSuccesses,
          windowStartedAt: window.windowStartedAt,
          windowFailures: window.windowFailures,
          windowSuccesses: window.windowSuccesses,
          openedAt: null,
          cooldownUntil: null,
          cooldownLevel: 0,
          halfOpenAttempts: 0,
          halfOpenSuccesses: 0,
          lastErrorType: null,
          lastErrorMessage: null,
          lastTripReason: null,
        })
        .where(eq(integrationHealth.id, existing.id));
      await appendEvent(db, {
        integrationId,
        destinationId,
        eventType: "closed",
        fromState: "HALF_OPEN",
        toState: "CLOSED",
        reason: `probe succeeded (${halfOpenSuccesses}/${policy.probesToClose})`,
        metadata: params.metadata ?? null,
      });
      return {
        fromState: "HALF_OPEN",
        toState: "CLOSED",
        transitioned: true,
        reason: "probe_succeeded",
      };
    }

    if (!success) {
      // Probe failed — re-open with one rung higher on the ladder.
      const newLevel = isMaxLevel(policy, existing.cooldownLevel)
        ? existing.cooldownLevel
        : existing.cooldownLevel + 1;
      const cooldownUntil = new Date(now.getTime() + cooldownMsForLevel(policy, newLevel));
      await db
        .update(integrationHealth)
        .set({
          state: "OPEN",
          consecutiveFailures,
          consecutiveSuccesses: 0,
          windowStartedAt: window.windowStartedAt,
          windowFailures: window.windowFailures,
          windowSuccesses: window.windowSuccesses,
          openedAt: now,
          cooldownUntil,
          cooldownLevel: newLevel,
          halfOpenAttempts: 0,
          halfOpenSuccesses: 0,
          lastErrorType: klass,
          lastErrorMessage: (params.errorMessage ?? "").slice(0, 500) || null,
          lastTripReason: "probe_failed",
        })
        .where(eq(integrationHealth.id, existing.id));
      await appendEvent(db, {
        integrationId,
        destinationId,
        eventType: "probe_failed",
        fromState: "HALF_OPEN",
        toState: "OPEN",
        reason: `cooldownLevel=${newLevel}, until=${cooldownUntil.toISOString()}`,
        errorType: klass,
        metadata: params.metadata ?? null,
      });
      return {
        fromState: "HALF_OPEN",
        toState: "OPEN",
        transitioned: true,
        reason: "probe_failed",
      };
    }

    // Success but not enough probes yet — stay HALF_OPEN, accrue.
    await db
      .update(integrationHealth)
      .set({
        consecutiveFailures: 0,
        consecutiveSuccesses,
        windowStartedAt: window.windowStartedAt,
        windowFailures: window.windowFailures,
        windowSuccesses: window.windowSuccesses,
        halfOpenAttempts,
        halfOpenSuccesses,
      })
      .where(eq(integrationHealth.id, existing.id));
    return {
      fromState: "HALF_OPEN",
      toState: "HALF_OPEN",
      transitioned: false,
      reason: null,
    };
  }

  // ── OPEN: outcomes don't change state, but still record metrics ──
  if (fromState === "OPEN") {
    // We don't expect deliveries while OPEN — but a legitimate path is the
    // shadow scheduler still dispatching (Phase 0) or an admin manual retry.
    // Record the outcome without re-opening or transitioning.
    await db
      .update(integrationHealth)
      .set({
        consecutiveFailures,
        consecutiveSuccesses,
        windowStartedAt: window.windowStartedAt,
        windowFailures: window.windowFailures,
        windowSuccesses: window.windowSuccesses,
        lastErrorType: success ? existing.lastErrorType : klass,
        lastErrorMessage: success
          ? existing.lastErrorMessage
          : (params.errorMessage ?? "").slice(0, 500) || null,
      })
      .where(eq(integrationHealth.id, existing.id));
    return { fromState: "OPEN", toState: "OPEN", transitioned: false, reason: null };
  }

  // ── CLOSED: maybe trip ──
  const trip = shouldTrip(
    policy,
    consecutiveFailures,
    window.windowFailures,
    window.windowSuccesses,
  );

  if (!trip.trip) {
    await db
      .update(integrationHealth)
      .set({
        consecutiveFailures,
        consecutiveSuccesses,
        windowStartedAt: window.windowStartedAt,
        windowFailures: window.windowFailures,
        windowSuccesses: window.windowSuccesses,
        lastErrorType: success ? existing.lastErrorType : klass,
        lastErrorMessage: success
          ? existing.lastErrorMessage
          : (params.errorMessage ?? "").slice(0, 500) || null,
      })
      .where(eq(integrationHealth.id, existing.id));
    return { fromState: "CLOSED", toState: "CLOSED", transitioned: false, reason: null };
  }

  // Trip → OPEN. Level starts at 0 since we're coming from CLOSED.
  const level = 0;
  const cooldownUntil = new Date(now.getTime() + cooldownMsForLevel(policy, level));
  await db
    .update(integrationHealth)
    .set({
      state: "OPEN",
      consecutiveFailures,
      consecutiveSuccesses: 0,
      windowStartedAt: window.windowStartedAt,
      windowFailures: window.windowFailures,
      windowSuccesses: window.windowSuccesses,
      openedAt: now,
      cooldownUntil,
      cooldownLevel: level,
      halfOpenAttempts: 0,
      halfOpenSuccesses: 0,
      lastErrorType: klass,
      lastErrorMessage: (params.errorMessage ?? "").slice(0, 500) || null,
      lastTripReason: trip.reason.slice(0, 64),
    })
    .where(eq(integrationHealth.id, existing.id));

  await appendEvent(db, {
    integrationId,
    destinationId,
    eventType: "opened",
    fromState: "CLOSED",
    toState: "OPEN",
    reason: trip.reason,
    errorType: klass,
    metadata: { ...(params.metadata ?? {}), cooldownLevel: level, cooldownUntil: cooldownUntil.toISOString() },
  });

  return {
    fromState: "CLOSED",
    toState: "OPEN",
    transitioned: true,
    reason: trip.reason,
  };
}

/**
 * Decide whether a claimed order should be dispatched. Phase 0 callers MUST
 * proceed regardless of the returned decision — they just log it.
 *
 * Side effects:
 *   - When `cooldownUntil <= now` for an OPEN row, transitions it to
 *     HALF_OPEN and emits a `half_opened` event. This is the "natural"
 *     promotion that lets the next caller start probing.
 */
export async function evaluateClaim(
  db: DbClient,
  params: EvaluateClaimParams,
): Promise<EvaluateClaimResult> {
  const now = params.now ?? new Date();
  const row = await loadRow(db, params.integrationId, params.destinationId);

  // Never seen this destination — fall back to per-app sibling check when
  // the caller supplied an appKey (otherwise we have nothing to compare).
  // Without this branch a brand-new destination of an already-rate-limited
  // app would freely fire on first contact and only get its own CB row
  // after taking a 429 to the face.
  if (!row) {
    if (params.appKey) {
      const sibRes = (await db.execute(sql`
        SELECT COUNT(*) AS n FROM integration_health
        WHERE appKey = ${params.appKey}
          AND state = 'OPEN'
          AND (cooldownUntil IS NULL OR cooldownUntil > NOW())
      `)) as unknown as [Array<{ n: number }>, unknown];
      const openSiblings = Number(sibRes[0]?.[0]?.n ?? 0);
      if (openSiblings > 0) {
        return {
          decision: "block",
          state: "CLOSED",
          reason: `app_sibling_open (${openSiblings} sibling${openSiblings > 1 ? "s" : ""} of '${params.appKey}' OPEN)`,
          cooldownUntil: null,
          manualLock: null,
        };
      }
    }
    return {
      decision: "allow",
      state: "CLOSED",
      reason: "no_health_row",
      cooldownUntil: null,
      manualLock: null,
    };
  }

  // Manual override takes precedence over computed state.
  if (row.manualLock === "OPEN") {
    return {
      decision: "block",
      state: row.state as CircuitState,
      reason: "manual_lock_open",
      cooldownUntil: row.cooldownUntil ?? null,
      manualLock: "OPEN",
    };
  }
  if (row.manualLock === "CLOSED") {
    return {
      decision: "allow",
      state: row.state as CircuitState,
      reason: "manual_lock_closed",
      cooldownUntil: row.cooldownUntil ?? null,
      manualLock: "CLOSED",
    };
  }

  const state = row.state as CircuitState;

  if (state === "CLOSED") {
    // Per-app sibling check (Phase 2B): if any sibling destination of the
    // same app is currently OPEN, treat THIS destination as blocked too.
    // Prevents a partner-wide rate limit (e.g. 100k.uz returning 429) from
    // being discovered one destination at a time — once any sibling is
    // OPEN, the rest back off without taking turns failing.
    const effectiveAppKey = params.appKey ?? row.appKey ?? null;
    if (effectiveAppKey) {
      const sibRes = (await db.execute(sql`
        SELECT COUNT(*) AS n FROM integration_health
        WHERE appKey = ${effectiveAppKey}
          AND state = 'OPEN'
          AND (cooldownUntil IS NULL OR cooldownUntil > NOW())
          AND NOT (integrationId = ${params.integrationId} AND destinationId = ${params.destinationId})
      `)) as unknown as [Array<{ n: number }>, unknown];
      const openSiblings = Number(sibRes[0]?.[0]?.n ?? 0);
      if (openSiblings > 0) {
        return {
          decision: "block",
          state,
          reason: `app_sibling_open (${openSiblings} sibling${openSiblings > 1 ? "s" : ""} of '${effectiveAppKey}' OPEN)`,
          cooldownUntil: null,
          manualLock: null,
        };
      }
    }
    return {
      decision: "allow",
      state,
      reason: "closed",
      cooldownUntil: null,
      manualLock: null,
    };
  }

  if (state === "HALF_OPEN") {
    const policy = getPolicy(row.lastErrorType as DeliveryErrorType | null);
    const budgetExhausted = row.halfOpenAttempts >= policy.probeBudget;
    return {
      decision: budgetExhausted ? "block" : "probe",
      state,
      reason: budgetExhausted
        ? `half_open_budget_exhausted (${row.halfOpenAttempts}/${policy.probeBudget})`
        : `half_open_probe (${row.halfOpenAttempts}/${policy.probeBudget})`,
      cooldownUntil: row.cooldownUntil ?? null,
      manualLock: null,
    };
  }

  // OPEN — check whether the cooldown expired; promote to HALF_OPEN if so.
  // Comparison happens server-side (see loadRow) so we don't get bitten by
  // mysql2 client-timezone parsing differences across pool connections.
  if (row.cooldownExpired) {
    const policy = getPolicy(row.lastErrorType as DeliveryErrorType | null);

    // Auth at max level: require human before resuming.
    if (
      row.lastErrorType === "auth" &&
      isMaxLevel(policy, row.cooldownLevel) &&
      policy.requireManualCloseAtMax
    ) {
      return {
        decision: "block",
        state: "OPEN",
        reason: "auth_max_requires_manual_close",
        cooldownUntil: row.cooldownUntil ?? null,
        manualLock: null,
      };
    }

    await db
      .update(integrationHealth)
      .set({
        state: "HALF_OPEN",
        halfOpenAttempts: 0,
        halfOpenSuccesses: 0,
      })
      .where(eq(integrationHealth.id, row.id));
    await appendEvent(db, {
      integrationId: params.integrationId,
      destinationId: params.destinationId,
      eventType: "half_opened",
      fromState: "OPEN",
      toState: "HALF_OPEN",
      reason: "cooldown_expired",
    });
    return {
      decision: "probe",
      state: "HALF_OPEN",
      reason: "half_open_probe (0/probe_budget)",
      cooldownUntil: row.cooldownUntil ?? null,
      manualLock: null,
    };
  }

  return {
    decision: "block",
    state: "OPEN",
    reason: `cooldown_active until ${row.cooldownUntil?.toISOString() ?? "?"}`,
    cooldownUntil: row.cooldownUntil ?? null,
    manualLock: null,
  };
}

/**
 * Phase 0 helper: record what the breaker WOULD have decided without acting
 * on it. Caller passes the legacy outcome (the order was/was-not dispatched)
 * so the audit row captures the divergence.
 */
export async function recordShadowDecision(
  db: DbClient,
  params: {
    integrationId: number;
    destinationId: number;
    decision: Decision;
    state: CircuitState;
    reason: string;
    legacyDispatched: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const divergent = (params.decision === "block") && params.legacyDispatched;
  await appendEvent(db, {
    integrationId: params.integrationId,
    destinationId: params.destinationId,
    eventType: divergent ? "shadow_would_block" : "shadow_would_allow",
    toState: params.state,
    reason: params.reason,
    metadata: {
      ...(params.metadata ?? {}),
      decision: params.decision,
      legacyDispatched: params.legacyDispatched,
    },
  });
}

// ─── Enforcement (Phase 1A — admin path only by default) ───────────────────

/**
 * Where CB enforcement applies. Controlled by `CB_ENFORCEMENT` env var so we
 * can roll it out path-by-path without code changes:
 *
 *   - `disabled`    (default)        → no path enforces; everyone runs in
 *                                       shadow mode (Phase 0 behaviour).
 *   - `admin_only`  (Phase 1A)       → admin retry endpoints enforce; the
 *                                       hourly scheduler stays in shadow until
 *                                       we've validated thresholds.
 *   - `all`         (Phase 1B)       → scheduler enforces too.
 *
 * Per-call `force: true` always bypasses the breaker (with an audit row).
 * Per-call `enforce: true` opts a non-admin caller in even when the global
 * scope is `admin_only` (rarely needed).
 */
export type EnforcementScope = "disabled" | "admin_only" | "all";

export function getEnforcementScope(): EnforcementScope {
  const raw = process.env.CB_ENFORCEMENT?.trim().toLowerCase();
  if (raw === "admin_only" || raw === "all" || raw === "disabled") return raw;
  return "disabled";
}

export type EvaluateOptions = {
  /** The retry path doing the check. Determines whether the global scope applies. */
  caller: "scheduler" | "admin" | "system";
  /**
   * Admin override — proceed even if breaker would block. Audited as
   * `manual_force` so we can spot a destination that keeps getting forced
   * through (signal that the breaker is wrong, the destination is genuinely
   * broken, or someone is fighting the system).
   */
  force?: boolean;
  /**
   * Force enforcement for this single call regardless of `CB_ENFORCEMENT`.
   * Lets a caller opt in (or out) explicitly — e.g. a "preview" endpoint
   * that wants the breaker's verdict even when global scope is `disabled`.
   */
  enforce?: boolean;
};

export type GuardResult = {
  /** Final decision once scope + force + manualLock are folded in. */
  shouldBlock: boolean;
  /** Raw CB decision (allow / block / probe) for telemetry. */
  decision: Decision;
  state: CircuitState;
  reason: string;
  cooldownUntil: Date | null;
  manualLock: "OPEN" | "CLOSED" | null;
  /** True when the caller asked us to skip enforcement here. */
  enforced: boolean;
  /** True when `force` flipped a `block` to `allow`. Audited separately. */
  forced: boolean;
};

/**
 * One-stop guard for callers that need to ASK the breaker before dispatching.
 * Combines:
 *   - `evaluateClaim` (the state-machine decision)
 *   - the global `CB_ENFORCEMENT` scope
 *   - the per-call `force` / `enforce` overrides
 *   - audit-log side effect on `force` (so we can spot abuse)
 *
 * Returns `shouldBlock = true` iff the caller MUST NOT dispatch.
 * Returns `shouldBlock = false` for: shadow mode, allowed state, half-open
 * probe (caller treats success as recovery signal), or admin force.
 */
export async function evaluateAndMaybeBlock(
  db: DbClient,
  params: {
    integrationId: number;
    destinationId: number;
    options: EvaluateOptions;
    /** Free-form context attached to any `manual_force` audit row. */
    metadata?: Record<string, unknown>;
  },
): Promise<GuardResult> {
  const scope = getEnforcementScope();
  const enforced =
    params.options.enforce ??
    (scope === "all" ||
      (scope === "admin_only" && params.options.caller === "admin"));

  const ev = await evaluateClaim(db, {
    integrationId: params.integrationId,
    destinationId: params.destinationId,
  });

  // Not enforcing this call: tell caller to proceed; record nothing (shadow
  // logs are the scheduler's responsibility — admin/non-enforced calls don't
  // duplicate them).
  if (!enforced) {
    return {
      shouldBlock: false,
      decision: ev.decision,
      state: ev.state,
      reason: `${ev.reason} (enforcement=off)`,
      cooldownUntil: ev.cooldownUntil,
      manualLock: ev.manualLock,
      enforced: false,
      forced: false,
    };
  }

  const wouldBlock = ev.decision === "block";

  // Force override: log it so we can spot a destination that keeps getting
  // bypassed (admin fighting an OPEN breaker → either the breaker is too
  // aggressive or the destination really is permanently broken).
  if (wouldBlock && params.options.force) {
    await appendEvent(db, {
      integrationId: params.integrationId,
      destinationId: params.destinationId,
      eventType: "manual_force",
      fromState: ev.state,
      toState: ev.state,
      reason: `force-bypass by ${params.options.caller}: ${ev.reason}`,
      metadata: params.metadata ?? null,
    });
    return {
      shouldBlock: false,
      decision: ev.decision,
      state: ev.state,
      reason: `force-bypassed: ${ev.reason}`,
      cooldownUntil: ev.cooldownUntil,
      manualLock: ev.manualLock,
      enforced: true,
      forced: true,
    };
  }

  return {
    shouldBlock: wouldBlock,
    decision: ev.decision,
    state: ev.state,
    reason: ev.reason,
    cooldownUntil: ev.cooldownUntil,
    manualLock: ev.manualLock,
    enforced: true,
    forced: false,
  };
}

// ─── Auto-promotion (Phase 2C fix) ─────────────────────────────────────────

/**
 * Promote every OPEN row whose cooldownUntil has elapsed to HALF_OPEN.
 *
 * Why this exists: `evaluateClaim` auto-promotes opportunistically when it's
 * called for a destination. But promotion only fires if SOMETHING drives a
 * call — typically a scheduler-claimed order. If a destination has no
 * scheduled retries (all its FAILED orders are validation orphans with
 * nextRetryAt=NULL, for instance), the row stays OPEN forever and the next
 * initial dispatch from the webhook keeps padding `consecutiveFailures` on
 * an already-OPEN row without ever giving the partner a recovery probe.
 *
 * This helper short-circuits that: a single UPDATE per scheduler tick
 * promotes any OPEN row with an expired cooldown, so the NEXT outgoing
 * delivery (initial dispatch or retry) hits HALF_OPEN and runs probe
 * semantics — closing the breaker on success.
 *
 * Returns the number of rows promoted.
 */
export async function autoPromoteExpiredCooldowns(db: DbClient): Promise<number> {
  const result = (await db.execute(sql`
    UPDATE integration_health
    SET state = 'HALF_OPEN', halfOpenAttempts = 0, halfOpenSuccesses = 0
    WHERE state = 'OPEN'
      AND cooldownUntil IS NOT NULL
      AND cooldownUntil <= NOW()
      AND COALESCE(manualLock, '') != 'OPEN'
  `)) as unknown as Array<{ affectedRows?: number }>;
  const promoted = result?.[0]?.affectedRows ?? 0;

  // Audit one event per promotion so the timeline shows the half-open
  // transition. Single bulk INSERT…SELECT keeps it cheap.
  if (promoted > 0) {
    await db.execute(sql`
      INSERT INTO integration_health_events
        (integrationId, destinationId, eventType, fromState, toState, reason, createdAt)
      SELECT integrationId, destinationId, 'half_opened', 'OPEN', 'HALF_OPEN',
             'auto_promoted_cooldown_expired', NOW()
      FROM integration_health
      WHERE state = 'HALF_OPEN' AND halfOpenAttempts = 0
        AND updatedAt >= NOW() - INTERVAL 5 SECOND
    `);
  }

  return promoted;
}

// ─── Admin pre-check helpers (Phase 1A UI) ─────────────────────────────────

export type DestinationCBSnapshot = {
  integrationId: number;
  destinationId: number;
  integrationName: string | null;
  decision: Decision;
  state: CircuitState;
  cooldownUntil: Date | null;
  manualLock: "OPEN" | "CLOSED" | null;
  /** Order rows on this lead/destination that are currently retryable. */
  orderIds: number[];
};

export type LeadCBPreview = {
  leadId: number;
  /** Distinct destinations this lead has touched (from existing orders). */
  destinations: DestinationCBSnapshot[];
  /** Convenience flags for UI. */
  allBlocked: boolean;
  anyBlocked: boolean;
  earliestRecoveryAt: Date | null;
};

/**
 * What would the breaker say for each of a single lead's destinations? Used by
 * `leads.retryLead` to render a warning before dispatching. We key on the
 * order rows (lead has already been delivered at least once for retry to be
 * meaningful), so the answer is grounded in real prior dispatches rather
 * than re-running the routing logic.
 *
 * Read-only — has no side effects on the breaker state.
 */
export async function previewLeadCBState(
  db: DbClient,
  leadId: number,
): Promise<LeadCBPreview> {
  // Inline raw SELECT so we can return integrationName in one round-trip
  // without importing the integrations / orders tables into this file's
  // type surface (keeps the CB module decoupled from order schema details).
  const rowsRes = (await db.execute(sql`
    SELECT
      o.integrationId,
      o.destinationId,
      i.name AS integrationName,
      JSON_ARRAYAGG(o.id) AS orderIds
    FROM orders o
    LEFT JOIN integrations i ON i.id = o.integrationId
    WHERE o.leadId = ${leadId}
    GROUP BY o.integrationId, o.destinationId, i.name
  `)) as unknown as [Array<{
    integrationId: number;
    destinationId: number;
    integrationName: string | null;
    orderIds: number[] | string | null;
  }>, unknown];

  const rows = rowsRes[0] ?? [];
  if (rows.length === 0) {
    return { leadId, destinations: [], allBlocked: false, anyBlocked: false, earliestRecoveryAt: null };
  }

  const destinations: DestinationCBSnapshot[] = [];
  for (const r of rows) {
    const ev = await evaluateClaim(db, {
      integrationId: Number(r.integrationId),
      destinationId: Number(r.destinationId ?? 0),
    });
    const parsedIds = Array.isArray(r.orderIds)
      ? r.orderIds.map(Number).filter((n) => Number.isFinite(n))
      : typeof r.orderIds === "string"
        ? (JSON.parse(r.orderIds) as number[])
        : [];
    destinations.push({
      integrationId: Number(r.integrationId),
      destinationId: Number(r.destinationId ?? 0),
      integrationName: r.integrationName,
      decision: ev.decision,
      state: ev.state,
      cooldownUntil: ev.cooldownUntil,
      manualLock: ev.manualLock,
      orderIds: parsedIds,
    });
  }

  const allBlocked = destinations.every((d) => d.decision === "block");
  const anyBlocked = destinations.some((d) => d.decision === "block");
  const cooldowns = destinations
    .map((d) => d.cooldownUntil?.getTime())
    .filter((t): t is number => typeof t === "number");
  const earliestRecoveryAt = cooldowns.length > 0 ? new Date(Math.min(...cooldowns)) : null;

  return { leadId, destinations, allBlocked, anyBlocked, earliestRecoveryAt };
}

/**
 * Bulk preview for the "Retry All Failed Leads" button. Groups all
 * dispatchable failed orders by `(integrationId, destinationId)` and returns
 * how many would be retried per destination, alongside the breaker state.
 *
 * The UI uses this to render the "523 OK destinations, 1289 OPEN — proceed
 * with which?" modal.
 */
export type BulkCBPreview = {
  totalOrders: number;
  totalLeads: number;
  byDestination: Array<DestinationCBSnapshot & { orderCount: number; leadCount: number }>;
};

export async function previewBulkRetryCBState(
  db: DbClient,
  params: {
    /** Filter: only orders for this user. Omit to scan everything (admin DLQ). */
    userId?: number;
    /** Filter: only orders with `attempts >= minAttempts`. Default 0 (any). */
    minAttempts?: number;
    /** Filter: only orders with `attempts < maxAttempts`. Use ORDER_MAX_DELIVERY_ATTEMPTS for retryable; omit for exhausted (DLQ). */
    maxAttempts?: number;
    onlyFailed?: boolean;
  },
): Promise<BulkCBPreview> {
  const whereParts: string[] = [];
  if (params.onlyFailed !== false) whereParts.push("o.status = 'FAILED'");
  if (params.userId != null) whereParts.push(`o.userId = ${Number(params.userId)}`);
  if (params.minAttempts != null) whereParts.push(`o.attempts >= ${Number(params.minAttempts)}`);
  if (params.maxAttempts != null) whereParts.push(`o.attempts < ${Number(params.maxAttempts)}`);
  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const rowsRes = (await db.execute(sql.raw(`
    SELECT
      o.integrationId,
      o.destinationId,
      i.name AS integrationName,
      COUNT(*) AS orderCount,
      COUNT(DISTINCT o.leadId) AS leadCount
    FROM orders o
    LEFT JOIN integrations i ON i.id = o.integrationId
    ${whereClause}
    GROUP BY o.integrationId, o.destinationId, i.name
    ORDER BY orderCount DESC
  `))) as unknown as [Array<{
    integrationId: number;
    destinationId: number;
    integrationName: string | null;
    orderCount: number;
    leadCount: number;
  }>, unknown];

  const rows = rowsRes[0] ?? [];
  let totalOrders = 0;
  const leadIds = new Set<number>();
  const byDestination: Array<DestinationCBSnapshot & { orderCount: number; leadCount: number }> = [];

  for (const r of rows) {
    const orderCount = Number(r.orderCount);
    totalOrders += orderCount;
    const ev = await evaluateClaim(db, {
      integrationId: Number(r.integrationId),
      destinationId: Number(r.destinationId ?? 0),
    });
    byDestination.push({
      integrationId: Number(r.integrationId),
      destinationId: Number(r.destinationId ?? 0),
      integrationName: r.integrationName,
      decision: ev.decision,
      state: ev.state,
      cooldownUntil: ev.cooldownUntil,
      manualLock: ev.manualLock,
      orderIds: [], // populated lazily by callers that need them
      orderCount,
      leadCount: Number(r.leadCount),
    });
  }

  // For totalLeads we do one more pass — JOIN-aware COUNT DISTINCT would be
  // wrong because the same lead can appear under multiple destinations.
  const distinctRes = (await db.execute(sql.raw(`
    SELECT COUNT(DISTINCT o.leadId) AS n FROM orders o
    ${whereClause}
  `))) as unknown as [Array<{ n: number }>, unknown];
  const totalLeads = Number(distinctRes[0]?.[0]?.n ?? 0);

  return { totalOrders, totalLeads, byDestination };
}

// Re-export the policy table for callers that want to introspect without
// re-importing from lib/.
export { CIRCUIT_POLICY };

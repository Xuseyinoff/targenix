/**
 * circuitBreakerService — Phase 10 of the Make.com-style refactor.
 *
 * In-memory circuit breaker per delivery destination (keyed by destinationId
 * or, for legacy single-destination orders, by integrationId).
 *
 * State machine:
 *   CLOSED  → OPEN       : failureCount >= FAILURE_THRESHOLD consecutive failures
 *   OPEN    → HALF_OPEN  : openedAt + OPEN_DURATION_MS has elapsed (next request)
 *   HALF_OPEN → CLOSED   : first success in half-open state
 *   HALF_OPEN → OPEN     : first failure in half-open state
 *
 * Notes:
 *   • State resets on process restart (in-memory only). This is intentional for
 *     Phase 10 — persistent state would require a background sweep job. A deploy
 *     clears stuck-open circuits automatically.
 *   • Not thread-safe in a distributed environment; fine for a single Node.js
 *     process. A future Redis-backed implementation can swap this module out.
 *   • failureCount is reset to 0 on any success in CLOSED state — "streak" semantics
 *     (not "sliding window"). Simpler and avoids false trips from old noise.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitStatus {
  key: string;
  state: CircuitState;
  failureCount: number;
  openedAt: Date | null;
  nextRetryAt: Date | null;
  /** Estimated time until half-open (null when already closed or half-open). */
  remainingCooldownMs: number | null;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Consecutive failures required to trip the circuit. */
const FAILURE_THRESHOLD = 5;
/** How long the circuit stays OPEN before moving to HALF_OPEN. */
const OPEN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ─── Internal state ───────────────────────────────────────────────────────────

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  openedAt: Date | null;
}

const _state = new Map<string, CircuitEntry>();

function getOrCreate(key: string): CircuitEntry {
  let entry = _state.get(key);
  if (!entry) {
    entry = { state: "closed", failureCount: 0, openedAt: null };
    _state.set(key, entry);
  }
  return entry;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether a delivery attempt is allowed.
 * Returns `{ allowed: false, reason }` when the circuit is OPEN.
 * Transitions OPEN → HALF_OPEN automatically when the cooldown has elapsed.
 */
export function isCircuitAllowed(key: string): { allowed: boolean; reason?: string } {
  const entry = getOrCreate(key);

  if (entry.state === "closed") {
    return { allowed: true };
  }

  if (entry.state === "open") {
    const now = Date.now();
    const elapsed = entry.openedAt ? now - entry.openedAt.getTime() : Infinity;
    if (elapsed >= OPEN_DURATION_MS) {
      // Transition to half-open — allow one probe attempt
      entry.state = "half-open";
      return { allowed: true };
    }
    const remainingS = Math.ceil((OPEN_DURATION_MS - elapsed) / 1000);
    return {
      allowed: false,
      reason: `Circuit open for '${key}' — too many failures. Retrying in ${remainingS}s.`,
    };
  }

  // half-open: allow the single probe
  return { allowed: true };
}

/** Record a successful delivery for a key. Closes the circuit. */
export function recordCircuitSuccess(key: string): void {
  const entry = getOrCreate(key);
  entry.state = "closed";
  entry.failureCount = 0;
  entry.openedAt = null;
}

/** Record a failed delivery for a key. May trip the circuit. */
export function recordCircuitFailure(key: string): void {
  const entry = getOrCreate(key);

  if (entry.state === "half-open") {
    // Probe failed — reopen immediately
    entry.state = "open";
    entry.openedAt = new Date();
    return;
  }

  if (entry.state === "open") {
    // Already open — nothing to update (openedAt stays the same)
    return;
  }

  // Closed — increment streak
  entry.failureCount += 1;
  if (entry.failureCount >= FAILURE_THRESHOLD) {
    entry.state = "open";
    entry.openedAt = new Date();
  }
}

/** Manually reset a circuit (admin action). */
export function resetCircuit(key: string): void {
  _state.delete(key);
}

/** List all non-closed circuits (for the admin dashboard). */
export function listOpenCircuits(): CircuitStatus[] {
  const now = Date.now();
  const result: CircuitStatus[] = [];

  _state.forEach((entry, key) => {
    if (entry.state === "closed" && entry.failureCount === 0) return;

    const nextRetryAt =
      entry.state === "open" && entry.openedAt
        ? new Date(entry.openedAt.getTime() + OPEN_DURATION_MS)
        : null;

    const remainingCooldownMs =
      entry.state === "open" && nextRetryAt
        ? Math.max(0, nextRetryAt.getTime() - now)
        : null;

    result.push({
      key,
      state:               entry.state,
      failureCount:        entry.failureCount,
      openedAt:            entry.openedAt,
      nextRetryAt,
      remainingCooldownMs,
    });
  });

  return result.sort((a, b) => {
    const ord: Record<CircuitState, number> = { open: 0, "half-open": 1, closed: 2 };
    return ord[a.state] - ord[b.state];
  });
}

/** Returns ALL circuit entries including closed ones with non-zero failure counts. */
export function getCircuitSnapshot(): CircuitStatus[] {
  const now = Date.now();
  const out: CircuitStatus[] = [];
  _state.forEach((entry, key) => {
    const nextRetryAt =
      entry.state === "open" && entry.openedAt
        ? new Date(entry.openedAt.getTime() + OPEN_DURATION_MS)
        : null;
    out.push({
      key,
      state:               entry.state,
      failureCount:        entry.failureCount,
      openedAt:            entry.openedAt,
      nextRetryAt,
      remainingCooldownMs: entry.state === "open" && nextRetryAt
        ? Math.max(0, nextRetryAt.getTime() - now) : null,
    });
  });
  return out;
}

/** Build a circuit key for a delivery target. */
export function circuitKey(destinationId: number, integrationId: number): string {
  return destinationId > 0 ? `dest:${destinationId}` : `int:${integrationId}`;
}

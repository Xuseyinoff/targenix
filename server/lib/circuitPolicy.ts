/**
 * Per-errorType circuit-breaker policy.
 *
 * Tuned to match the existing retry classifier in `orderRetryPolicy.ts`:
 *   - `network`     — DNS / timeout / 5xx — flaky but usually self-heals
 *   - `rate_limit`  — explicit 429 — provider asked us to slow down
 *   - `auth`        — 401/403 — credential rotation or revoke; needs a human
 *   - `validation`  — 400/422 — bad request data; retrying won't help
 *   - `unknown`     — fallback for un-classified failures
 *
 * Fast-trip vs sliding window: each policy carries BOTH thresholds.
 *   - `consecutiveTrip`: the streak that opens the breaker immediately
 *     (covers cliff failures — DNS dies → every request fails in a row)
 *   - `windowSize` + `windowFailureRatio`: opens the breaker when failures
 *     dominate a rolling window of recent traffic, even with successes
 *     interleaved (covers degraded providers — every 3rd request 502s)
 *
 * `cooldownLadder`: exponential back-off across consecutive re-opens. Index 0
 * is used the first time the breaker opens; each re-open during the same
 * outage increments the index (capped at the last entry). The level resets
 * to 0 once the breaker closes via probe success.
 *
 * `windowMs`: rolling window length. We use a TUMBLING approximation —
 * counters reset whenever the window age exceeds this — which is simpler
 * than a true sliding window and accurate enough for breaker decisions.
 */

import type { DeliveryErrorType } from "./orderRetryPolicy";

export type CircuitErrorClass = DeliveryErrorType | "unknown";

export type CircuitPolicy = {
  /** Trip on N consecutive failures. Set to Infinity to disable (validation). */
  consecutiveTrip: number;
  /** Minimum samples in window before ratio check applies (avoids 1/1 = 100%). */
  windowMinSamples: number;
  /** Window length in ms. Counters reset when `now - windowStartedAt > windowMs`. */
  windowMs: number;
  /** Trip when `failures / total >= this` AND `total >= windowMinSamples`. */
  windowFailureRatio: number;
  /** Cooldown durations (ms) per re-open. Final entry is reused if exceeded. */
  cooldownLadder: readonly number[];
  /** Half-open probe budget: how many orders we let through per HALF_OPEN entry. */
  probeBudget: number;
  /** Probes needed to close: success count required before flipping to CLOSED. */
  probesToClose: number;
  /** When true, after the final cooldownLadder step we stay OPEN until admin clears `manualLock`. */
  requireManualCloseAtMax: boolean;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

export const CIRCUIT_POLICY: Record<CircuitErrorClass, CircuitPolicy> = {
  // Explicit 429 from upstream — they told us to back off. Trip on the first
  // signal; we already wasted budget making the call. Long ladder so we don't
  // pound a rate-limited API every minute.
  rate_limit: {
    consecutiveTrip: 1,
    windowMinSamples: 1,
    windowMs: 5 * MIN,
    windowFailureRatio: 0.0, // any 429 in window trips
    cooldownLadder: [1 * MIN, 5 * MIN, 15 * MIN, 1 * HOUR],
    probeBudget: 1,
    probesToClose: 1,
    requireManualCloseAtMax: false,
  },

  // DNS / timeout / 5xx — providers go up and down. Tolerate small bursts;
  // open quickly if it's clearly broken.
  network: {
    consecutiveTrip: 5,
    windowMinSamples: 10,
    windowMs: 5 * MIN,
    windowFailureRatio: 0.5,
    cooldownLadder: [1 * MIN, 5 * MIN, 15 * MIN, 30 * MIN],
    probeBudget: 2,
    probesToClose: 1,
    requireManualCloseAtMax: false,
  },

  // 401/403 — credentials are broken or revoked. Retrying without admin
  // intervention is almost always futile; ramp fast, then lock for human.
  auth: {
    consecutiveTrip: 3,
    windowMinSamples: 3,
    windowMs: 10 * MIN,
    windowFailureRatio: 0.8,
    cooldownLadder: [10 * MIN, 30 * MIN, 2 * HOUR],
    probeBudget: 1,
    probesToClose: 1,
    requireManualCloseAtMax: true,
  },

  // 400/422 — request shape is wrong. The breaker is the wrong tool here:
  // each failing order has a unique payload problem, retrying any of them
  // won't help. Never trip the breaker on validation; let individual orders
  // exhaust attempts and surface in the DLQ.
  validation: {
    consecutiveTrip: Number.POSITIVE_INFINITY,
    windowMinSamples: Number.MAX_SAFE_INTEGER,
    windowMs: 5 * MIN,
    windowFailureRatio: 1.01, // unreachable
    cooldownLadder: [0],
    probeBudget: 0,
    probesToClose: 1,
    requireManualCloseAtMax: false,
  },

  // Unclassified — be cautious but not paranoid.
  unknown: {
    consecutiveTrip: 8,
    windowMinSamples: 15,
    windowMs: 5 * MIN,
    windowFailureRatio: 0.6,
    cooldownLadder: [2 * MIN, 10 * MIN, 30 * MIN],
    probeBudget: 1,
    probesToClose: 1,
    requireManualCloseAtMax: false,
  },
};

export function getPolicy(errorType: DeliveryErrorType | null | undefined): CircuitPolicy {
  if (!errorType) return CIRCUIT_POLICY.unknown;
  return CIRCUIT_POLICY[errorType] ?? CIRCUIT_POLICY.unknown;
}

/**
 * Resolve the cooldown duration for a given level. Levels beyond the ladder
 * length are clamped to the last entry (sustained outage stays at the max,
 * never longer).
 */
export function cooldownMsForLevel(policy: CircuitPolicy, level: number): number {
  const idx = Math.min(Math.max(level, 0), policy.cooldownLadder.length - 1);
  return policy.cooldownLadder[idx]!;
}

/**
 * Is this level the terminal one (last entry of the ladder)? Used together
 * with `requireManualCloseAtMax` to decide whether to refuse auto-recovery.
 */
export function isMaxLevel(policy: CircuitPolicy, level: number): boolean {
  return level >= policy.cooldownLadder.length - 1;
}

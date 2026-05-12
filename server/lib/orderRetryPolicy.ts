// Retry policy tunables — read from env at module load with safe defaults.
// All values can be overridden per-deployment without touching code.

import { envInt } from "./envHelpers";

/** Max completed delivery tries per order (initial try + timed retries). */
export const ORDER_MAX_DELIVERY_ATTEMPTS = envInt("ORDER_MAX_DELIVERY_ATTEMPTS", 3);

/** Legacy fixed delay when delivery did not set `errorType` (1 hour default). */
export const ORDER_RETRY_INTERVAL_MS = envInt(
  "ORDER_RETRY_INTERVAL_MS",
  60 * 60 * 1000,
);

/**
 * Milliseconds to wait after failure #N before scheduling the next retry
 * (N is 1-based new `attempts`). Override the entire ladder by setting
 * `ORDER_RETRY_BACKOFF_MS` to a comma-separated list, e.g.
 * `ORDER_RETRY_BACKOFF_MS=60000,300000,1800000` for 1m/5m/30m.
 */
const RETRY_BACKOFF_AFTER_FAILURE_MS: readonly number[] = (() => {
  const raw = process.env.ORDER_RETRY_BACKOFF_MS;
  if (raw) {
    const parts = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parts.length > 0) return parts;
  }
  return [
    5 * 60 * 1000, // after 1st failed attempt
    15 * 60 * 1000, // after 2nd
    60 * 60 * 1000, // after 3rd+ (only used if maxAttempts were raised)
  ];
})();

export type DeliveryErrorType = "network" | "auth" | "validation" | "rate_limit";

/**
 * Best-effort classification for handlers. No match → `undefined` (caller may omit `errorType`).
 */
export function inferDeliveryErrorType(input: {
  httpStatus?: number;
  message?: string;
}): DeliveryErrorType | undefined {
  const status = input.httpStatus;
  const msg = (input.message ?? "").toLowerCase();

  if (status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return "rate_limit";
  }
  if (status === 401 || status === 403 || msg.includes("unauthorized") || msg.includes("forbidden")) {
    return "auth";
  }
  if (
    status === 400 ||
    status === 422 ||
    msg.includes("invalid_grant") ||
    msg.includes("bad request") ||
    (status === 404 && (msg.includes("not found") || msg.includes("requested entity was not found")))
  ) {
    return "validation";
  }
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (typeof status === "number" && status >= 500)
  ) {
    return "network";
  }
  return undefined;
}

/**
 * When to schedule the next automatic retry (null = no retry).
 * - If `errorType` is **undefined** (caller did not classify): legacy fixed delay `ORDER_RETRY_INTERVAL_MS` (1h).
 * - If `errorType` is set:
 *   - validation → never retry
 *   - auth → at most one follow-up (no schedule once `newAttempts >= 2`)
 *   - rate_limit → exponential steps with a floor of 15 minutes (unless
 *     the provider gave us an explicit `retryAfterMs`)
 *   - network → exponential steps (5m, 15m, 60m)
 *
 * `retryAfterMs` overrides the policy ladder when the provider explicitly
 * told us how long to wait (`Retry-After` / `X-RateLimit-Reset`). We respect
 * the partner's instruction rather than re-deriving it — partners love
 * clients that honour their rate-limit headers, and it stops us from
 * burning the IP reputation by guessing wrong.
 */
export function computeNextRetryAt(params: {
  now: Date;
  newAttempts: number;
  maxAttempts: number;
  success: boolean;
  errorType?: DeliveryErrorType;
  /** Provider-suggested cooldown in ms (e.g. parsed from `Retry-After`). */
  retryAfterMs?: number;
}): Date | null {
  const { now, newAttempts, maxAttempts, success, errorType, retryAfterMs } = params;
  if (success || newAttempts >= maxAttempts) return null;
  if (errorType === "validation") return null;
  if (errorType === "auth" && newAttempts >= 2) return null;

  // Provider gave us a Retry-After: honour it (clamped to a sane window so a
  // misbehaving partner can't park the order for a week).
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    const clamped = Math.min(Math.max(retryAfterMs, 1_000), 6 * 60 * 60 * 1000); // 1s–6h
    return new Date(now.getTime() + clamped);
  }

  if (errorType === undefined) {
    return new Date(now.getTime() + ORDER_RETRY_INTERVAL_MS);
  }

  const idx = Math.min(Math.max(newAttempts - 1, 0), RETRY_BACKOFF_AFTER_FAILURE_MS.length - 1);
  let delayMs = RETRY_BACKOFF_AFTER_FAILURE_MS[idx]!;
  if (errorType === "rate_limit") {
    delayMs = Math.max(delayMs, 15 * 60 * 1000);
  }
  return new Date(now.getTime() + delayMs);
}

/**
 * Parse `Retry-After` and `X-RateLimit-Reset` headers from a Fetch Response
 * into milliseconds. Returns `undefined` when no usable signal is present.
 *
 * Header semantics:
 *   - `Retry-After: 41`              — seconds (delta)
 *   - `Retry-After: <HTTP-date>`     — absolute time
 *   - `X-RateLimit-Reset: 1779000`   — unix epoch seconds
 *   - `X-RateLimit-Reset: 41`        — some APIs use seconds-delta (we
 *     disambiguate by checking magnitude: < 10^10 ⇒ delta, else epoch)
 *
 * All values clamped to non-negative.
 */
export function parseRetryAfterHeader(headers: Headers | Record<string, string | null | undefined>): number | undefined {
  const read = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const v = (headers as Record<string, string | null | undefined>)[name]
      ?? (headers as Record<string, string | null | undefined>)[name.toLowerCase()];
    return v ?? null;
  };

  const retryAfter = read("Retry-After") ?? read("retry-after");
  if (retryAfter) {
    const asNumber = Number(retryAfter.trim());
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.round(asNumber * 1000);
    }
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const deltaMs = asDate - Date.now();
      return deltaMs > 0 ? deltaMs : 0;
    }
  }

  const rlReset = read("X-RateLimit-Reset") ?? read("x-ratelimit-reset");
  if (rlReset) {
    const n = Number(rlReset.trim());
    if (Number.isFinite(n) && n >= 0) {
      // Heuristic: > 10^10 ⇒ epoch milliseconds; > 10^9 ⇒ epoch seconds;
      // anything smaller is a seconds-delta. The thresholds avoid mistaking
      // a 60-second delta for an epoch value.
      if (n > 1e10) {
        return Math.max(0, n - Date.now());
      }
      if (n > 1e9) {
        return Math.max(0, n * 1000 - Date.now());
      }
      return Math.round(n * 1000);
    }
  }

  return undefined;
}

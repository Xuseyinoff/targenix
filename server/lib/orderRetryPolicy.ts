/** Max completed delivery tries per order (initial try + timed retries). */
export const ORDER_MAX_DELIVERY_ATTEMPTS = 3;

/** Legacy fixed delay when delivery did not set `errorType` (1 hour). */
export const ORDER_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** Milliseconds to wait after failure #N before scheduling the next retry (N is 1-based new `attempts`). */
const RETRY_BACKOFF_AFTER_FAILURE_MS = [
  5 * 60 * 1000, // after 1st failed attempt
  15 * 60 * 1000, // after 2nd
  60 * 60 * 1000, // after 3rd+ (only used if maxAttempts were raised)
] as const;

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
 *   - rate_limit → exponential steps with a floor of 15 minutes
 *   - network → exponential steps (5m, 15m, 60m)
 */
export function computeNextRetryAt(params: {
  now: Date;
  newAttempts: number;
  maxAttempts: number;
  success: boolean;
  errorType?: DeliveryErrorType;
}): Date | null {
  const { now, newAttempts, maxAttempts, success, errorType } = params;
  if (success || newAttempts >= maxAttempts) return null;
  if (errorType === "validation") return null;
  if (errorType === "auth" && newAttempts >= 2) return null;

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

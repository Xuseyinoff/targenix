// Retry policy for Facebook Graph enrichment failures on the `leads` table.
//
// Mirrors `orderRetryPolicy.ts` but classifies FB Graph errors instead of
// outbound HTTP delivery errors. Used by the per-minute retry scheduler
// (`retryDueGraphErrorLeads`) and by `processLead` when it persists a
// failed attempt.

import { envInt } from "./envHelpers";

/** Max completed Graph attempts before the scheduler stops claiming the lead. */
export const LEAD_MAX_GRAPH_ATTEMPTS = envInt("LEAD_MAX_GRAPH_ATTEMPTS", 3);

/** Legacy fixed delay when the caller did not classify the error (1 hour). */
export const LEAD_RETRY_INTERVAL_MS = envInt(
  "LEAD_RETRY_INTERVAL_MS",
  60 * 60 * 1000,
);

/**
 * Milliseconds to wait after failure #N before the next retry (N is 1-based
 * new `dataAttempts`). Override the entire ladder via
 * `LEAD_RETRY_BACKOFF_MS=60000,300000,1800000`.
 */
const RETRY_BACKOFF_AFTER_FAILURE_MS: readonly number[] = (() => {
  const raw = process.env.LEAD_RETRY_BACKOFF_MS;
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
    60 * 60 * 1000, // after 3rd+ (only used if max were raised)
  ];
})();

/**
 * Outcome of a Graph fetch, classified into buckets the scheduler can act on.
 *
 *   - `permanently_missing` — Graph code 100 (subcode 33): lead was deleted
 *     by FB (spam filter, user retention, etc). No point retrying — once
 *     this fires the scheduler gives up forever.
 *   - `auth`                — token invalid/expired (code 190 or 102).
 *     One follow-up retry (e.g. webhook race during a token rotation), then
 *     stop; only a reconnect from the user clears auth.
 *   - `validation`          — request shape rejected (code 100 with another
 *     subcode, code 803, etc). Like `permanently_missing` in practice.
 *   - `rate_limit`          — code 4 / 17 / 80004. Respect Retry-After when
 *     the provider sent one, else 15m+ floor.
 *   - `network`             — timeout, 5xx, DNS / connection error. Standard
 *     exponential ladder.
 */
export type GraphErrorType = "permanently_missing" | "auth" | "validation" | "rate_limit" | "network";

/**
 * Map a Graph error response → policy bucket. The caller passes whatever it
 * has: FB error code/subcode (when present in the JSON body), HTTP status,
 * and the human message. Unknown shapes fall back to `network` so they get
 * retried — better to over-retry than over-give-up.
 */
export function classifyGraphError(input: {
  httpStatus?: number;
  fbErrorCode?: number;
  fbErrorSubcode?: number;
  message?: string;
}): GraphErrorType {
  const status = input.httpStatus;
  const code = input.fbErrorCode;
  const subcode = input.fbErrorSubcode;
  const msg = (input.message ?? "").toLowerCase();

  // Permanently-missing leads: FB's classic "Object with ID does not exist"
  // is code=100, subcode=33. Sometimes the subcode is missing but the
  // message text is unambiguous.
  if (
    (code === 100 && subcode === 33) ||
    msg.includes("does not exist") ||
    msg.includes("object does not exist")
  ) {
    return "permanently_missing";
  }

  // Auth: code 190 (access token problems), code 102 (session has been
  // invalidated). Also HTTP 401/403 with no FB code.
  if (
    code === 190 ||
    code === 102 ||
    (typeof status === "number" && (status === 401 || status === 403))
  ) {
    return "auth";
  }

  // Rate limit: codes 4 (app), 17 (user), 80004 (page), HTTP 429.
  if (
    code === 4 ||
    code === 17 ||
    code === 80004 ||
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many calls")
  ) {
    return "rate_limit";
  }

  // Validation: the request was malformed and won't succeed on retry.
  // FB code 803 = "Some of the aliases you requested do not exist".
  if (
    code === 803 ||
    status === 400 ||
    status === 422 ||
    msg.includes("invalid parameter")
  ) {
    return "validation";
  }

  // Everything else (timeouts, 5xx, transient network) → retry.
  return "network";
}

/**
 * When to schedule the next Graph retry. `null` = no more retries.
 *
 *   - success → null (caller should also clear dataStatus)
 *   - attempts exhausted → null
 *   - permanently_missing / validation → null
 *   - auth → one follow-up only (null once dataAttempts >= 2)
 *   - rate_limit → floor 15m unless provider gave Retry-After
 *   - network / undefined → exponential ladder
 *
 * `retryAfterMs` overrides the policy ladder when the provider explicitly
 * told us how long to wait. Clamped to 1s–6h so a misbehaving provider
 * can't park a lead for a week.
 */
export function computeLeadNextRetryAt(params: {
  now: Date;
  newAttempts: number;
  maxAttempts?: number;
  success: boolean;
  errorType?: GraphErrorType;
  retryAfterMs?: number;
}): Date | null {
  const { now, newAttempts, success, errorType, retryAfterMs } = params;
  const maxAttempts = params.maxAttempts ?? LEAD_MAX_GRAPH_ATTEMPTS;
  if (success || newAttempts >= maxAttempts) return null;
  if (errorType === "permanently_missing" || errorType === "validation") return null;
  if (errorType === "auth" && newAttempts >= 2) return null;

  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    const clamped = Math.min(Math.max(retryAfterMs, 1_000), 6 * 60 * 60 * 1000);
    return new Date(now.getTime() + clamped);
  }

  if (errorType === undefined) {
    return new Date(now.getTime() + LEAD_RETRY_INTERVAL_MS);
  }

  const idx = Math.min(Math.max(newAttempts - 1, 0), RETRY_BACKOFF_AFTER_FAILURE_MS.length - 1);
  let delayMs = RETRY_BACKOFF_AFTER_FAILURE_MS[idx]!;
  if (errorType === "rate_limit") {
    delayMs = Math.max(delayMs, 15 * 60 * 1000);
  }
  return new Date(now.getTime() + delayMs);
}

/**
 * Per-page sliding window rate limit for inbound Facebook lead webhooks.
 *
 * Why this exists: the webhook always ACKs Facebook with 200 BEFORE the
 * lead is queued (see facebookWebhook.ts:153). Without rate limiting,
 * a single page firing leads at >100/sec floods BullMQ + the WORKER —
 * one tenant's traffic burst can starve every other tenant's deliveries.
 *
 * The limit is per-pageId, not per-user, because:
 *   1. Facebook delivers webhooks keyed by pageId. We resolve userIds
 *      AFTER the rate-check, so per-user gating would require an extra
 *      DB round-trip per inbound webhook just to identify the tenant.
 *   2. The DoS vector is per-PAGE — a malicious page can produce more
 *      leads than a malicious user, since one page may be connected to
 *      multiple tenants.
 *
 * Behaviour when the cap is exceeded:
 *   - The webhook still returns 200 to Facebook (we already did).
 *   - The lead is NOT saved or queued; it is logged as throttled so
 *     admins can spot abuse / runaway campaigns.
 *   - The counter auto-resets after `windowMs`, so a burst doesn't
 *     permanently blacklist the page.
 *
 * In-memory state is fine for a single-WORKER deployment; if the WORKER
 * is ever horizontally scaled, swap the buckets Map for Redis (BullMQ
 * connection is already there) to share state across replicas.
 */

interface PageBucket {
  /** Lead count in the current window. */
  count: number;
  /** Wall-clock time at which the window resets. */
  resetAt: number;
}

const buckets = new Map<string, PageBucket>();

// Garbage-collect expired buckets every 5 min so a malicious page that
// goes quiet doesn't keep its entry around forever.
setInterval(() => {
  const now = Date.now();
  buckets.forEach((b, k) => {
    if (now >= b.resetAt) buckets.delete(k);
  });
}, 5 * 60 * 1000).unref();

const envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Default cap: 120 leads/min per page — generous for any legitimate campaign. */
export const PAGE_LEADS_PER_MIN_MAX = envInt("WEBHOOK_PAGE_LEADS_PER_MIN", 120);
const WINDOW_MS = 60_000;

export interface RateLimitDecision {
  /** True when the lead should be processed normally. */
  allowed: boolean;
  /** Current count in the window — only meaningful when allowed=false. */
  count: number;
  /** Cap that the count is being compared against. */
  cap: number;
  /** Seconds until the window resets (rounded up). */
  retryAfterSec: number;
}

/**
 * Record one inbound lead for the given pageId and return a decision.
 *
 * Idempotent semantics: every call increments the counter and returns
 * whether the caller should proceed. Callers must NOT call this twice
 * for the same lead — once per webhook arrival, before queueing.
 */
export function checkPageLeadRate(pageId: string): RateLimitDecision {
  const now = Date.now();
  let bucket = buckets.get(pageId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(pageId, bucket);
  }
  bucket.count++;

  const allowed = bucket.count <= PAGE_LEADS_PER_MIN_MAX;
  return {
    allowed,
    count: bucket.count,
    cap: PAGE_LEADS_PER_MIN_MAX,
    retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** Test-only — clears state between cases. */
export function __resetWebhookRateLimitBuckets(): void {
  buckets.clear();
}

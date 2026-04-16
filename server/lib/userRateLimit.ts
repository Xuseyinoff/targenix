import { TRPCError } from "@trpc/server";

interface BucketEntry {
  count: number;
  resetAt: number;
}

interface UserRateLimitConfig {
  /** Max requests allowed in the window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Error message shown to user */
  message?: string;
}

const buckets = new Map<string, BucketEntry>();

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  buckets.forEach((entry, key) => {
    if (now >= entry.resetAt) buckets.delete(key);
  });
}, 5 * 60 * 1000).unref();

/**
 * Per-user rate limiter for tRPC procedures.
 * Each (userId + label) pair has its own independent bucket.
 *
 * Usage in routers:
 *   import { checkUserRateLimit } from "../lib/userRateLimit";
 *   // inside mutation:
 *   checkUserRateLimit(ctx.user.id, "testIntegration", { max: 5, windowMs: 60_000 });
 */
export function checkUserRateLimit(
  userId: number,
  label: string,
  config: UserRateLimitConfig
): void {
  const key = `${userId}:${label}`;
  const now = Date.now();

  let entry = buckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + config.windowMs };
    buckets.set(key, entry);
  }

  entry.count++;

  if (entry.count > config.max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: config.message ?? `Too many requests. Please wait ${retryAfterSec} seconds.`,
    });
  }
}

/**
 * Generic in-process TTL cache for loader results.
 *
 * Replaces the ad-hoc per-file Maps in googleSheetsService.ts with a single,
 * shared, configurable cache that every loader can use.
 *
 * Design:
 *   • Key:   userId + loaderKey + serialised params (JSON-stable sort)
 *   • Value: { result, expiresAt }
 *   • TTL:   caller-configurable per lookup (default 60 s)
 *   • Eviction: lazy (on read) + periodic sweep every 5 min
 *
 * This is intentionally simple (in-process Map). A future Redis integration
 * would only need to swap the storage backend — the loaders call the same
 * loaderCache.get/set API.
 *
 * Security: keys always include userId so a different tenant's request
 * can never hit another tenant's cached result.
 */

import type { LoadOptionsResult } from "./types";

interface CacheEntry {
  result: LoadOptionsResult;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

/** Build a deterministic cache key from variable-length inputs. */
function buildKey(
  userId: number,
  loaderKey: string,
  connectionId: number | null,
  params: Record<string, unknown>,
  search: string | undefined,
  cursor: string | undefined,
  limit: number,
): string {
  // Stable JSON serialisation — sort keys so { a:1, b:2 } === { b:2, a:1 }.
  const stableParams = JSON.stringify(
    Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `u${userId}:${loaderKey}:c${connectionId ?? "null"}:${stableParams}:s${search ?? ""}:cur${cursor ?? ""}:l${limit}`;
}

/** Evict all expired entries (called periodically and before every read). */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of Array.from(store.entries())) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

// Sweep every 5 minutes so the Map doesn't grow unboundedly.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepRunning(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(evictExpired, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for the cache sweep.
  if (sweepTimer.unref) sweepTimer.unref();
}

export interface LoaderCacheOptions {
  /** Cache TTL in seconds. Default: 60. */
  ttlSeconds?: number;
}

export const loaderCache = {
  /**
   * Look up a cached result.
   * Returns null on cache miss or expired entry (entry is deleted on miss).
   */
  get(
    userId: number,
    loaderKey: string,
    connectionId: number | null,
    params: Record<string, unknown>,
    search: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): LoadOptionsResult | null {
    ensureSweepRunning();
    const key = buildKey(userId, loaderKey, connectionId, params, search, cursor, limit);
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.result;
  },

  /** Store a result with the given TTL. */
  set(
    userId: number,
    loaderKey: string,
    connectionId: number | null,
    params: Record<string, unknown>,
    search: string | undefined,
    cursor: string | undefined,
    limit: number,
    result: LoadOptionsResult,
    opts: LoaderCacheOptions = {},
  ): void {
    ensureSweepRunning();
    const ttlMs = (opts.ttlSeconds ?? 60) * 1000;
    const key = buildKey(userId, loaderKey, connectionId, params, search, cursor, limit);
    store.set(key, { result, expiresAt: Date.now() + ttlMs });
  },

  /** Invalidate all entries for a specific user+loader (e.g. after reconnect). */
  invalidate(userId: number, loaderKey: string): void {
    const prefix = `u${userId}:${loaderKey}:`;
    for (const key of Array.from(store.keys())) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  },

  /** Test helper — clears everything. */
  __clear(): void {
    store.clear();
  },

  /** Current entry count — for monitoring / tests. */
  get size(): number {
    return store.size;
  },
};

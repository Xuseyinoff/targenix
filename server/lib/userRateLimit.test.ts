import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { checkRateLimitByKey, checkUserRateLimit } from "./userRateLimit";

// The module keeps an in-memory bucket Map keyed by string. Tests use a
// fresh, unique key per case so they never collide with each other (the
// Map is module-global and not exported for reset).
let keyCounter = 0;
function freshKey(): string {
  return `test-key-${Date.now()}-${keyCounter++}`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimitByKey", () => {
  it("allows exactly `max` calls inside the window, throws on max+1", () => {
    const key = freshKey();
    const cfg = { max: 3, windowMs: 60_000 };

    // First 3 calls pass.
    expect(() => checkRateLimitByKey(key, cfg)).not.toThrow();
    expect(() => checkRateLimitByKey(key, cfg)).not.toThrow();
    expect(() => checkRateLimitByKey(key, cfg)).not.toThrow();

    // 4th call trips the limit.
    expect(() => checkRateLimitByKey(key, cfg)).toThrow(TRPCError);
  });

  it("throws TOO_MANY_REQUESTS with the custom message", () => {
    const key = freshKey();
    const cfg = { max: 1, windowMs: 60_000, message: "Slow down please." };
    checkRateLimitByKey(key, cfg);
    try {
      checkRateLimitByKey(key, cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("TOO_MANY_REQUESTS");
      expect((err as TRPCError).message).toBe("Slow down please.");
    }
  });

  it("resets the bucket once the window elapses", () => {
    const key = freshKey();
    const cfg = { max: 2, windowMs: 60_000 };

    checkRateLimitByKey(key, cfg);
    checkRateLimitByKey(key, cfg);
    expect(() => checkRateLimitByKey(key, cfg)).toThrow(TRPCError);

    // Advance past the window — the bucket resets and calls pass again.
    vi.advanceTimersByTime(60_001);
    expect(() => checkRateLimitByKey(key, cfg)).not.toThrow();
    expect(() => checkRateLimitByKey(key, cfg)).not.toThrow();
    expect(() => checkRateLimitByKey(key, cfg)).toThrow(TRPCError);
  });

  it("keeps independent buckets per key", () => {
    const keyA = freshKey();
    const keyB = freshKey();
    const cfg = { max: 1, windowMs: 60_000 };

    checkRateLimitByKey(keyA, cfg);
    // keyB is untouched — its own bucket still has headroom.
    expect(() => checkRateLimitByKey(keyB, cfg)).not.toThrow();
    // keyA is already at the limit.
    expect(() => checkRateLimitByKey(keyA, cfg)).toThrow(TRPCError);
  });
});

describe("checkUserRateLimit", () => {
  it("isolates buckets by (userId, label) pair", () => {
    const label = freshKey();
    const cfg = { max: 1, windowMs: 60_000 };

    checkUserRateLimit(1, label, cfg);
    // Different user, same label → separate bucket.
    expect(() => checkUserRateLimit(2, label, cfg)).not.toThrow();
    // Same user, different label → separate bucket.
    expect(() => checkUserRateLimit(1, `${label}-other`, cfg)).not.toThrow();
    // Same user, same label → limited.
    expect(() => checkUserRateLimit(1, label, cfg)).toThrow(TRPCError);
  });

  it("blocks a bulk-create spam pattern (30/min ceiling)", () => {
    const label = freshKey();
    const cfg = { max: 30, windowMs: 60_000, message: "Too many destinations created. Max 30 per minute." };

    // 30 creates pass — generous headroom for a real setup session.
    for (let i = 0; i < 30; i++) {
      expect(() => checkUserRateLimit(99, label, cfg)).not.toThrow();
    }
    // The 31st in the same minute is rejected — the scripted-spam case.
    expect(() => checkUserRateLimit(99, label, cfg)).toThrow(/Max 30 per minute/);
  });
});

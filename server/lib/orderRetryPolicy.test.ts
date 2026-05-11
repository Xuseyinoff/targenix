import { describe, expect, it } from "vitest";
import {
  computeNextRetryAt,
  parseRetryAfterHeader,
} from "./orderRetryPolicy";

// ─── parseRetryAfterHeader ─────────────────────────────────────────────────

describe("parseRetryAfterHeader", () => {
  it("parses `Retry-After: <seconds>` form", () => {
    const h = new Headers({ "Retry-After": "41" });
    expect(parseRetryAfterHeader(h)).toBe(41_000);
  });

  it("parses `Retry-After: <HTTP-date>` form", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const h = new Headers({ "Retry-After": future });
    const ms = parseRetryAfterHeader(h);
    expect(ms).toBeGreaterThanOrEqual(58_000);
    expect(ms).toBeLessThanOrEqual(62_000);
  });

  it("treats past HTTP-dates as 0 (no wait)", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const h = new Headers({ "Retry-After": past });
    expect(parseRetryAfterHeader(h)).toBe(0);
  });

  it("falls back to X-RateLimit-Reset as epoch seconds", () => {
    const epochSeconds = Math.floor(Date.now() / 1000) + 30;
    const h = new Headers({ "X-RateLimit-Reset": String(epochSeconds) });
    const ms = parseRetryAfterHeader(h);
    expect(ms).toBeGreaterThanOrEqual(28_000);
    expect(ms).toBeLessThanOrEqual(32_000);
  });

  it("treats small X-RateLimit-Reset values as seconds-delta", () => {
    const h = new Headers({ "X-RateLimit-Reset": "60" });
    // 60 is < 1e9 → seconds-delta → 60 * 1000 = 60_000
    expect(parseRetryAfterHeader(h)).toBe(60_000);
  });

  it("returns undefined when no header is present", () => {
    expect(parseRetryAfterHeader(new Headers())).toBeUndefined();
  });

  it("accepts a plain object too (lowercase keys)", () => {
    expect(parseRetryAfterHeader({ "retry-after": "10" })).toBe(10_000);
  });
});

// ─── computeNextRetryAt with retryAfterMs ──────────────────────────────────

describe("computeNextRetryAt — retryAfterMs override", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("honours retryAfterMs when provided (rate_limit)", () => {
    const r = computeNextRetryAt({
      now,
      newAttempts: 1,
      maxAttempts: 3,
      success: false,
      errorType: "rate_limit",
      retryAfterMs: 41_000,
    });
    expect(r).not.toBeNull();
    expect(r!.getTime()).toBe(now.getTime() + 41_000);
  });

  it("clamps absurdly large retryAfterMs values to 6 hours", () => {
    const r = computeNextRetryAt({
      now,
      newAttempts: 1,
      maxAttempts: 3,
      success: false,
      errorType: "rate_limit",
      retryAfterMs: 24 * 60 * 60 * 1000, // 1 day
    });
    expect(r!.getTime() - now.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it("clamps tiny retryAfterMs values to a 1-second floor", () => {
    const r = computeNextRetryAt({
      now,
      newAttempts: 1,
      maxAttempts: 3,
      success: false,
      errorType: "rate_limit",
      retryAfterMs: 100,
    });
    expect(r!.getTime() - now.getTime()).toBe(1_000);
  });

  it("falls back to policy ladder when retryAfterMs is undefined", () => {
    const r = computeNextRetryAt({
      now,
      newAttempts: 1,
      maxAttempts: 3,
      success: false,
      errorType: "rate_limit",
    });
    // rate_limit ladder index 0 = 1 min, but with 15-min floor
    expect(r!.getTime() - now.getTime()).toBe(15 * 60 * 1000);
  });

  it("ignores retryAfterMs for validation errors (still null)", () => {
    const r = computeNextRetryAt({
      now,
      newAttempts: 1,
      maxAttempts: 3,
      success: false,
      errorType: "validation",
      retryAfterMs: 30_000,
    });
    expect(r).toBeNull();
  });

  it("ignores retryAfterMs once max attempts reached", () => {
    const r = computeNextRetryAt({
      now,
      newAttempts: 3,
      maxAttempts: 3,
      success: false,
      errorType: "rate_limit",
      retryAfterMs: 30_000,
    });
    expect(r).toBeNull();
  });
});

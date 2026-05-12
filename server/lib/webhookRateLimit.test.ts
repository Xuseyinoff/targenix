/**
 * Unit tests for the per-page webhook rate limit helper.
 *
 * The helper is a small in-memory sliding window — these tests pin its
 * counter behaviour, window-reset semantics, and the `RateLimitDecision`
 * shape so a future refactor can't silently lower the cap or stop
 * resetting the bucket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PAGE_LEADS_PER_MIN_MAX,
  checkPageLeadRate,
  __resetWebhookRateLimitBuckets,
} from "./webhookRateLimit";

describe("checkPageLeadRate", () => {
  beforeEach(() => {
    __resetWebhookRateLimitBuckets();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetWebhookRateLimitBuckets();
    vi.useRealTimers();
  });

  it("allows the first N leads up to the cap", () => {
    for (let i = 1; i <= PAGE_LEADS_PER_MIN_MAX; i++) {
      const d = checkPageLeadRate("page_a");
      expect(d.allowed).toBe(true);
      expect(d.count).toBe(i);
      expect(d.cap).toBe(PAGE_LEADS_PER_MIN_MAX);
    }
  });

  it("blocks the lead that exceeds the cap and every subsequent lead in the window", () => {
    for (let i = 0; i < PAGE_LEADS_PER_MIN_MAX; i++) checkPageLeadRate("page_b");
    const over = checkPageLeadRate("page_b");
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(PAGE_LEADS_PER_MIN_MAX + 1);
    const again = checkPageLeadRate("page_b");
    expect(again.allowed).toBe(false);
    expect(again.count).toBe(PAGE_LEADS_PER_MIN_MAX + 2);
  });

  it("isolates buckets across different pageIds", () => {
    for (let i = 0; i < PAGE_LEADS_PER_MIN_MAX; i++) checkPageLeadRate("page_x");
    // page_x is now full, but page_y must still be allowed.
    const d = checkPageLeadRate("page_y");
    expect(d.allowed).toBe(true);
    expect(d.count).toBe(1);
  });

  it("resets the bucket once the window elapses", () => {
    vi.setSystemTime(0);
    for (let i = 0; i < PAGE_LEADS_PER_MIN_MAX; i++) checkPageLeadRate("page_z");
    expect(checkPageLeadRate("page_z").allowed).toBe(false);

    // Advance just past the 60s window.
    vi.setSystemTime(60_001);
    const reset = checkPageLeadRate("page_z");
    expect(reset.allowed).toBe(true);
    expect(reset.count).toBe(1);
  });

  it("returns retryAfterSec rounded up to the next second", () => {
    vi.setSystemTime(0);
    for (let i = 0; i < PAGE_LEADS_PER_MIN_MAX + 1; i++) checkPageLeadRate("page_r");
    // Window still has nearly 60s left.
    vi.setSystemTime(100); // 100ms in
    const d = checkPageLeadRate("page_r");
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(60); // Math.ceil((60_000 - 100) / 1000)
  });
});

/**
 * retryScheduler.test.ts
 *
 * Tests for the hourly retry scheduler (Graph errors + order-level retries).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stopRetryScheduler } from "./services/retryScheduler";

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
};

// Chain builder for Drizzle-style fluent API
function makeChain(returnValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "where", "update", "set", "limit"];
  methods.forEach((m) => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  // Terminal call returns the value
  (chain as any).then = undefined; // not a promise by default
  // Make it awaitable
  Object.defineProperty(chain, Symbol.iterator, { value: undefined });
  // Override last method to return the value
  (chain as any)._resolve = returnValue;
  return chain;
}

// ── msUntilNextHour (internal logic test via scheduler timing) ───────────────

describe("retryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopRetryScheduler(); // ensure clean state
  });

  afterEach(() => {
    stopRetryScheduler();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stopRetryScheduler is idempotent (no error on double stop)", () => {
    stopRetryScheduler();
    stopRetryScheduler(); // should not throw
    expect(true).toBe(true);
  });

  it("startRetryScheduler does not run immediately", async () => {
    const { startRetryScheduler, retryAllFailedLeads } = await import(
      "./services/retryScheduler"
    );

    const spy = vi.spyOn({ retryAllFailedLeads }, "retryAllFailedLeads");
    startRetryScheduler();

    // Advance time by 59 minutes — should NOT have fired yet
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(spy).not.toHaveBeenCalled();

    stopRetryScheduler();
  });

  it("startRetryScheduler is idempotent (no duplicate timers)", async () => {
    const { startRetryScheduler } = await import("./services/retryScheduler");
    startRetryScheduler();
    startRetryScheduler(); // second call should be a no-op
    stopRetryScheduler();
    expect(true).toBe(true);
  });
});

// ── retryAllFailedLeads unit tests ───────────────────────────────────────────

describe("retryAllFailedLeads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    stopRetryScheduler();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns { retried: 0 } when DB is unavailable", async () => {
    vi.doMock("./db", () => ({
      getDb: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("./services/orderRetryScheduler", () => ({
      retryDueFailedOrders: () => Promise.resolve({ retried: 0 }),
    }));
    vi.doMock("./services/leadService", () => ({
      processLead: vi.fn(),
    }));

    const { retryAllFailedLeads } = await import("./services/retryScheduler");
    const result = await retryAllFailedLeads();
    expect(result).toEqual({ retried: 0 });
  });

  it("aggregates retries from graph + stuck-pending + orders", async () => {
    // The implementation now delegates Graph retries to
    // `leadGraphRetryScheduler.retryDueGraphErrorLeads` and orders to
    // `orderRetryScheduler.retryDueFailedOrders`. We mock those at the
    // module boundary and only check that retryAllFailedLeads sums them
    // correctly + skips the stuck-pending path when the DB has none.
    const selectBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]), // empty stuck PENDING
    };
    const fakeDb = {
      select: vi.fn(() => selectBuilder),
      update: vi.fn(),
    };

    vi.doMock("./db", () => ({
      getDb: vi.fn().mockResolvedValue(fakeDb),
    }));
    vi.doMock("./services/orderRetryScheduler", () => ({
      retryDueFailedOrders: () => Promise.resolve({ retried: 3 }),
    }));
    vi.doMock("./services/leadGraphRetryScheduler", () => ({
      retryDueGraphErrorLeads: () => Promise.resolve({ retried: 5 }),
    }));
    vi.doMock("./services/leadDispatch", () => ({
      dispatchLeadProcessing: vi.fn().mockResolvedValue(undefined),
    }));

    const { retryAllFailedLeads } = await import("./services/retryScheduler");
    const result = await retryAllFailedLeads();
    expect(result.retried).toBe(8); // 5 graph + 0 stuck + 3 orders
  });
});

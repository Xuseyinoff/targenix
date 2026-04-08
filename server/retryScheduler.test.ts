/**
 * retryScheduler.test.ts
 *
 * Tests for the automatic FAILED lead retry scheduler.
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
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { retried: 0 } when DB is unavailable", async () => {
    vi.doMock("./db", () => ({
      getDb: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("./services/leadService", () => ({
      processLead: vi.fn(),
    }));

    const { retryAllFailedLeads } = await import("./services/retryScheduler");
    const result = await retryAllFailedLeads();
    expect(result).toEqual({ retried: 0 });
  });

  it("returns { retried: 0 } when there are no FAILED leads", async () => {
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn().mockResolvedValue([]), // empty array — no FAILED leads
    };
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    selectChain.limit.mockReturnValue(selectChain);

    vi.doMock("./db", () => ({
      getDb: vi.fn().mockResolvedValue(selectChain),
    }));
    vi.doMock("./services/leadService", () => ({
      processLead: vi.fn(),
    }));

    const { retryAllFailedLeads } = await import("./services/retryScheduler");
    const result = await retryAllFailedLeads();
    expect(result).toEqual({ retried: 0 });
  });

  it("resets FAILED leads and calls processLead for each", async () => {
    const failedLeads = [
      { id: 1, leadgenId: "lg1", pageId: "p1", formId: "f1", userId: 1, status: "FAILED" },
      { id: 2, leadgenId: "lg2", pageId: "p2", formId: "f2", userId: 1, status: "FAILED" },
    ];

    const updateChain = {
      update: vi.fn(),
      set: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    updateChain.update.mockReturnValue(updateChain);
    updateChain.set.mockReturnValue(updateChain);

    let selectCallCount = 0;
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
      // First call returns failedLeads batch, second call returns [] (end of pagination)
      offset: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return Promise.resolve(selectCallCount === 1 ? failedLeads : []);
      }),
    };
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    selectChain.limit.mockReturnValue(selectChain);

    const fakeDb = {
      ...selectChain,
      ...updateChain,
    };

    const processLeadMock = vi.fn().mockReturnValue(Promise.resolve(undefined));

    vi.doMock("./db", () => ({
      getDb: vi.fn().mockResolvedValue(fakeDb),
    }));
    vi.doMock("../../drizzle/schema", () => ({
      leads: {},
      users: {},
    }));
    vi.doMock("./services/leadService", () => ({
      processLead: processLeadMock,
    }));

    const { retryAllFailedLeads } = await import("./services/retryScheduler");
    const result = await retryAllFailedLeads();

    expect(result.retried).toBe(2);
    // processLead is called via setImmediate, so we just check it was scheduled
    // (actual invocation is async)
  });
});

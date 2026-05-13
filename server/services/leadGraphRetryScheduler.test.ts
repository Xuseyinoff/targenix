/**
 * Unit tests for the per-minute Graph-enrichment retry scheduler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retryDueGraphErrorLeads", () => {
  it("returns { retried: 0 } when DB is unavailable", async () => {
    vi.doMock("../db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
    vi.doMock("./leadDispatch", () => ({ dispatchLeadProcessing: vi.fn() }));

    const { retryDueGraphErrorLeads } = await import("./leadGraphRetryScheduler");
    const result = await retryDueGraphErrorLeads();
    expect(result).toEqual({ retried: 0 });
  });

  it("returns { retried: 0 } when no leads are due", async () => {
    // The function uses `db.transaction(cb)` then `tx.execute(sql)` → rows;
    // when no rows match, the inner branch returns [] and the function exits
    // before any dispatch.
    const fakeTx = {
      execute: vi.fn().mockResolvedValue([[], null]),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      })),
    };
    const fakeDb = {
      transaction: vi.fn(async (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx)),
    };
    const dispatch = vi.fn();
    vi.doMock("../db", () => ({ getDb: vi.fn().mockResolvedValue(fakeDb) }));
    vi.doMock("./leadDispatch", () => ({ dispatchLeadProcessing: dispatch }));

    const { retryDueGraphErrorLeads } = await import("./leadGraphRetryScheduler");
    const result = await retryDueGraphErrorLeads();
    expect(result).toEqual({ retried: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches each claimed lead via dispatchLeadProcessing", async () => {
    const dueRows = [
      { id: 10, leadgenId: "lg10", pageId: "p1", formId: "f1", userId: 1 },
      { id: 11, leadgenId: "lg11", pageId: "p1", formId: "f1", userId: 1 },
      { id: 12, leadgenId: "lg12", pageId: "p2", formId: "f2", userId: 2 },
    ];
    const fakeTx = {
      execute: vi.fn().mockResolvedValue([dueRows, null]),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      })),
    };
    const fakeDb = {
      transaction: vi.fn(async (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx)),
    };
    const dispatch = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../db", () => ({ getDb: vi.fn().mockResolvedValue(fakeDb) }));
    vi.doMock("./leadDispatch", () => ({ dispatchLeadProcessing: dispatch }));

    const { retryDueGraphErrorLeads } = await import("./leadGraphRetryScheduler");
    const result = await retryDueGraphErrorLeads({ concurrency: 2 });

    expect(result.retried).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ leadId: 10, leadgenId: "lg10" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ leadId: 11 }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ leadId: 12 }));
  });

  it("counts only successful dispatches (logs but does not throw on failure)", async () => {
    const dueRows = [
      { id: 1, leadgenId: "lg1", pageId: "p", formId: "f", userId: 1 },
      { id: 2, leadgenId: "lg2", pageId: "p", formId: "f", userId: 1 },
    ];
    const fakeTx = {
      execute: vi.fn().mockResolvedValue([dueRows, null]),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      })),
    };
    const fakeDb = {
      transaction: vi.fn(async (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx)),
    };
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));
    vi.doMock("../db", () => ({ getDb: vi.fn().mockResolvedValue(fakeDb) }));
    vi.doMock("./leadDispatch", () => ({ dispatchLeadProcessing: dispatch }));

    const { retryDueGraphErrorLeads } = await import("./leadGraphRetryScheduler");
    const result = await retryDueGraphErrorLeads({ concurrency: 1 });

    expect(result.retried).toBe(1); // only the first succeeded
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

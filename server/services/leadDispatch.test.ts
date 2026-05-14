import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────
// `ENV.isProduction` is evaluated once at import time, so the test mocks the
// env module and resets the mock per-case to flip production on/off.
const envMock = { ENV: { isProduction: false } };
vi.mock("../_core/env", () => envMock);

const enqueueLeadJob = vi.fn();
vi.mock("../queues/leadQueue", () => ({ enqueueLeadJob }));

const processLead = vi.fn().mockResolvedValue(undefined);
vi.mock("./leadService", () => ({ processLead }));

// Import AFTER mocks are registered.
const { dispatchLeadProcessing, getLeadDispatchMode } = await import("./leadDispatch");

const PAYLOAD = {
  leadId: 1,
  leadgenId: "lg-1",
  pageId: "p1",
  formId: "f1",
  userId: 42,
};

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

beforeEach(() => {
  enqueueLeadJob.mockReset();
  processLead.mockReset().mockResolvedValue(undefined);
  envMock.ENV.isProduction = false;
});

afterEach(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  vi.restoreAllMocks();
});

describe("dispatchLeadProcessing — Redis queue guard", () => {
  it("enqueues via BullMQ when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    await dispatchLeadProcessing(PAYLOAD);
    expect(enqueueLeadJob).toHaveBeenCalledTimes(1);
    expect(enqueueLeadJob).toHaveBeenCalledWith(PAYLOAD);
    expect(processLead).not.toHaveBeenCalled();
  });

  it("THROWS in production when REDIS_URL is missing (no silent in-process fallback)", async () => {
    delete process.env.REDIS_URL;
    envMock.ENV.isProduction = true;
    await expect(dispatchLeadProcessing(PAYLOAD)).rejects.toThrow(/REDIS_URL is not set in production/);
    expect(enqueueLeadJob).not.toHaveBeenCalled();
    expect(processLead).not.toHaveBeenCalled();
  });

  it("falls back to in-process setImmediate in development when REDIS_URL is missing", async () => {
    delete process.env.REDIS_URL;
    envMock.ENV.isProduction = false;
    await dispatchLeadProcessing(PAYLOAD);
    expect(enqueueLeadJob).not.toHaveBeenCalled();
    // setImmediate is async — wait one macrotask tick for the scheduled work.
    await new Promise((resolve) => setImmediate(resolve));
    expect(processLead).toHaveBeenCalledWith(PAYLOAD);
  });
});

describe("getLeadDispatchMode", () => {
  it("reports 'queue' when REDIS_URL is set", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(getLeadDispatchMode()).toBe("queue");
  });

  it("reports 'in-process' when REDIS_URL is missing", () => {
    delete process.env.REDIS_URL;
    expect(getLeadDispatchMode()).toBe("in-process");
  });
});

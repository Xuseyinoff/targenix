/**
 * leadPollingService — unit tests for the pure helpers that make the tick
 * correct. We mock the Drizzle client shape and the Facebook Graph helper
 * so the test never hits an external service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Must be declared before the service is imported so vi.mock() is hoisted
// correctly. The service reuses fetchLeadsFromForm + extractLeadFields from
// facebookService, and dispatchLeadProcessing from leadDispatch.

const fetchLeadsFromFormMock = vi.fn();
const dispatchLeadProcessingMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./facebookService", () => ({
  fetchLeadsFromForm: (...args: unknown[]) => fetchLeadsFromFormMock(...args),
  extractLeadFields: () => ({ fullName: "John", phone: "+998900000000", email: null }),
}));

vi.mock("./leadDispatch", () => ({
  dispatchLeadProcessing: (...args: unknown[]) => dispatchLeadProcessingMock(...args),
}));

vi.mock("../encryption", () => ({
  decrypt: (v: string) => `decrypted(${v})`,
}));

vi.mock("../db", () => ({
  getDb: () => Promise.resolve(mockDb),
}));

// The service is imported LAZILY inside each test via `await import()` so
// the mocks above are always in place.

// ─── Mock DbClient ──────────────────────────────────────────────────────────

interface MockDbConfig {
  targets: Array<{
    userId: number;
    pageId: string;
    pageName: string;
    formId: string;
    formName: string;
    encryptedPageToken: string;
    subscriptionStatus: "active" | "failed" | "inactive";
  }>;
  latestLeadByForm: Record<string, Date | null>;
  existingLeadgenIds: Set<string>;
}

let mockDb: unknown;
let mockConfig: MockDbConfig;

function buildMockDb(cfg: MockDbConfig) {
  // We emit a different shape depending on which table was queried. The
  // production code uses `.innerJoin(...)` only when reading targets, so we
  // detect that path first and short-circuit.
  return {
    select: vi.fn((columns?: Record<string, unknown>) => {
      // Targets query: no explicit columns → pulls full set with encryptedPageToken key
      const isTargetsQuery =
        columns && Object.prototype.hasOwnProperty.call(columns, "encryptedPageToken");

      if (isTargetsQuery) {
        return {
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => Promise.resolve(cfg.targets)),
          })),
        };
      }

      // deriveHoursBack: selects { latest }
      if (columns && Object.prototype.hasOwnProperty.call(columns, "latest")) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => {
              const key = `${cfg.targets[0]?.userId}:${cfg.targets[0]?.pageId}:${cfg.targets[0]?.formId}`;
              const latest = cfg.latestLeadByForm[key] ?? null;
              return Promise.resolve([{ latest }]);
            }),
          })),
        };
      }

      // findExistingLeadgenIds: selects { leadgenId }
      if (columns && Object.prototype.hasOwnProperty.call(columns, "leadgenId")) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() =>
              Promise.resolve(Array.from(cfg.existingLeadgenIds).map((id) => ({ leadgenId: id }))),
            ),
          })),
        };
      }

      // Default: { id } after insert
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ id: 999 }])),
            })),
            limit: vi.fn(() => Promise.resolve([{ id: 999 }])),
          })),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  };
}

beforeEach(() => {
  fetchLeadsFromFormMock.mockReset();
  dispatchLeadProcessingMock.mockReset().mockResolvedValue(undefined);
  mockConfig = {
    targets: [],
    latestLeadByForm: {},
    existingLeadgenIds: new Set(),
  };
  mockDb = buildMockDb(mockConfig);
});

afterEach(() => {
  vi.resetModules();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("leadPollingService.runLeadPollingTick", () => {
  it("no-ops and returns zero counters when no active forms exist", async () => {
    const { runLeadPollingTick } = await import("./leadPollingService");
    const result = await runLeadPollingTick();
    expect(result).toMatchObject({ forms: 0, leadsInserted: 0, leadsSkipped: 0, errors: 0 });
    expect(fetchLeadsFromFormMock).not.toHaveBeenCalled();
  });

  it("skips leads that already exist and dispatches only the new ones", async () => {
    mockConfig.targets = [
      {
        userId: 1,
        pageId: "p1",
        pageName: "P1",
        formId: "f1",
        formName: "F1",
        encryptedPageToken: "token-enc",
        subscriptionStatus: "active",
      },
    ];
    mockConfig.existingLeadgenIds = new Set(["lead-old"]);
    mockDb = buildMockDb(mockConfig);

    fetchLeadsFromFormMock.mockResolvedValue([
      { id: "lead-old", form_id: "f1", field_data: [] },
      { id: "lead-new", form_id: "f1", field_data: [] },
    ]);

    const { runLeadPollingTick } = await import("./leadPollingService");
    const result = await runLeadPollingTick();

    expect(result.forms).toBe(1);
    expect(result.leadsInserted).toBe(1);
    expect(result.leadsSkipped).toBe(1);
    expect(dispatchLeadProcessingMock).toHaveBeenCalledTimes(1);
    expect(dispatchLeadProcessingMock).toHaveBeenCalledWith(
      expect.objectContaining({ leadgenId: "lead-new", userId: 1, pageId: "p1" }),
    );
  });

  it("filters out connections whose subscriptionStatus is 'inactive'", async () => {
    mockConfig.targets = [
      {
        userId: 1,
        pageId: "p1",
        pageName: "P1",
        formId: "f1",
        formName: "F1",
        encryptedPageToken: "tok",
        subscriptionStatus: "inactive",
      },
    ];
    mockDb = buildMockDb(mockConfig);

    const { runLeadPollingTick } = await import("./leadPollingService");
    const result = await runLeadPollingTick();

    expect(result.forms).toBe(0);
    expect(fetchLeadsFromFormMock).not.toHaveBeenCalled();
  });

  it("increments error counter when the Graph fetch throws", async () => {
    mockConfig.targets = [
      {
        userId: 1,
        pageId: "p1",
        pageName: "P1",
        formId: "f1",
        formName: "F1",
        encryptedPageToken: "tok",
        subscriptionStatus: "active",
      },
    ];
    mockDb = buildMockDb(mockConfig);

    fetchLeadsFromFormMock.mockRejectedValue(new Error("rate_limited"));

    const { runLeadPollingTick } = await import("./leadPollingService");
    const result = await runLeadPollingTick();

    expect(result.forms).toBe(1);
    expect(result.leadsInserted).toBe(0);
    expect(result.errors).toBe(1);
    expect(dispatchLeadProcessingMock).not.toHaveBeenCalled();
  });
});

describe("leadPollingService.isLeadPollingEnabled", () => {
  it("is false by default", async () => {
    delete process.env.ENABLE_LEAD_POLLING;
    const { isLeadPollingEnabled } = await import("./leadPollingService");
    expect(isLeadPollingEnabled()).toBe(false);
  });

  it("is true when env flag is set to 'true'", async () => {
    process.env.ENABLE_LEAD_POLLING = "true";
    const { isLeadPollingEnabled } = await import("./leadPollingService");
    expect(isLeadPollingEnabled()).toBe(true);
    delete process.env.ENABLE_LEAD_POLLING;
  });

  it("is case-insensitive for the flag value", async () => {
    process.env.ENABLE_LEAD_POLLING = "TRUE";
    const { isLeadPollingEnabled } = await import("./leadPollingService");
    expect(isLeadPollingEnabled()).toBe(true);
    delete process.env.ENABLE_LEAD_POLLING;
  });
});

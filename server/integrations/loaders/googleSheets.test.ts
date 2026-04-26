import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the google sheets service BEFORE the module under test is imported.
vi.mock("../../services/googleSheetsService", () => ({
  listUserSpreadsheets: vi.fn(),
  getSpreadsheetSheetTitles: vi.fn(),
  getGoogleSheetHeaders: vi.fn(),
}));

import {
  getGoogleSheetHeaders,
  getSpreadsheetSheetTitles,
  listUserSpreadsheets,
} from "../../services/googleSheetsService";
import { __testing } from "./googleSheets";
import { LoaderValidationError, type LoadOptionsContext } from "./types";
import { loaderCache } from "./cache";

const { listSpreadsheets, listSheetTabs, getHeaders, resolveGoogleAccountId } =
  __testing;

/**
 * Stubbed DbClient — returns a chainable select builder that resolves to the
 * rows configured per test. Only the one query shape used by the loader
 * (select().from().where().limit()) is implemented.
 */
function makeDb(rows: unknown[]) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn(() => builder),
  } as unknown as LoadOptionsContext["db"];
}

function makeCtx(overrides: Partial<LoadOptionsContext>): LoadOptionsContext {
  return {
    userId: 1,
    db: makeDb([]),
    connectionId: null,
    params: {},
    limit: 50,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loaderCache.__clear();
});

describe("resolveGoogleAccountId", () => {
  it("throws when connectionId is null", async () => {
    await expect(resolveGoogleAccountId(makeCtx({}))).rejects.toBeInstanceOf(
      LoaderValidationError,
    );
  });

  it("throws when the connection does not exist", async () => {
    const ctx = makeCtx({ connectionId: 42, db: makeDb([]) });
    await expect(resolveGoogleAccountId(ctx)).rejects.toThrow(
      /does not belong to you/i,
    );
  });

  it("throws when the connection is the wrong type", async () => {
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([
        {
          id: 1,
          userId: 1,
          type: "telegram_bot",
          status: "active",
          oauthTokenId: null,
        },
      ]),
    });
    await expect(resolveGoogleAccountId(ctx)).rejects.toThrow(
      /expected 'google_sheets'/,
    );
  });

  it("throws when the connection is not active", async () => {
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([
        {
          id: 1,
          userId: 1,
          type: "google_sheets",
          status: "expired",
          oauthTokenId: 5,
        },
      ]),
    });
    await expect(resolveGoogleAccountId(ctx)).rejects.toThrow(/Reconnect/);
  });

  it("throws when oauthTokenId is missing", async () => {
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([
        {
          id: 1,
          userId: 1,
          type: "google_sheets",
          status: "active",
          oauthTokenId: null,
        },
      ]),
    });
    await expect(resolveGoogleAccountId(ctx)).rejects.toThrow(
      /missing a Google OAuth link/,
    );
  });

  it("returns oauthTokenId for the service on a healthy connection", async () => {
    const ctx = makeCtx({
      connectionId: 7,
      db: makeDb([
        {
          id: 7,
          userId: 1,
          type: "google_sheets",
          status: "active",
          oauthTokenId: 99,
        },
      ]),
    });
    await expect(resolveGoogleAccountId(ctx)).resolves.toBe(99);
  });
});

describe("listSpreadsheets loader", () => {
  const healthyRow = {
    id: 1,
    userId: 1,
    type: "google_sheets",
    status: "active",
    oauthTokenId: 99,
  };

  it("returns mapped spreadsheet options on success", async () => {
    vi.mocked(listUserSpreadsheets).mockResolvedValue({
      success: true,
      data: [
        { id: "sheet_a", name: "Alpha" },
        { id: "sheet_b", name: "Beta" },
      ],
    });
    const ctx = makeCtx({ connectionId: 1, db: makeDb([healthyRow]) });
    const res = await listSpreadsheets(ctx);
    expect(res.options).toEqual([
      { value: "sheet_a", label: "Alpha" },
      { value: "sheet_b", label: "Beta" },
    ]);
    expect(listUserSpreadsheets).toHaveBeenCalledWith({
      userId: 1,
      googleAccountId: 99,
      nameContains: undefined,
    });
  });

  it("forwards the search param when provided", async () => {
    vi.mocked(listUserSpreadsheets).mockResolvedValue({ success: true, data: [] });
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([healthyRow]),
      search: "sales",
    });
    await listSpreadsheets(ctx);
    expect(listUserSpreadsheets).toHaveBeenCalledWith(
      expect.objectContaining({ nameContains: "sales" }),
    );
  });

  it("throws a LoaderValidationError when the upstream fails", async () => {
    vi.mocked(listUserSpreadsheets).mockResolvedValue({
      success: false,
      error: "Token revoked",
    });
    const ctx = makeCtx({ connectionId: 1, db: makeDb([healthyRow]) });
    await expect(listSpreadsheets(ctx)).rejects.toThrow(/Token revoked/);
  });
});

describe("listSheetTabs loader", () => {
  const healthyRow = {
    id: 1,
    userId: 1,
    type: "google_sheets",
    status: "active",
    oauthTokenId: 99,
  };

  it("requires spreadsheetId in params", async () => {
    const ctx = makeCtx({ connectionId: 1, db: makeDb([healthyRow]), params: {} });
    await expect(listSheetTabs(ctx)).rejects.toThrow(/'spreadsheetId' is required/);
  });

  it("returns tab names as value+label pairs", async () => {
    vi.mocked(getSpreadsheetSheetTitles).mockResolvedValue({
      success: true,
      data: ["Sheet1", "Archive"],
    });
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([healthyRow]),
      params: { spreadsheetId: "abc" },
    });
    const res = await listSheetTabs(ctx);
    expect(res.options).toEqual([
      { value: "Sheet1", label: "Sheet1" },
      { value: "Archive", label: "Archive" },
    ]);
  });
});

describe("getSheetHeaders loader", () => {
  const healthyRow = {
    id: 1,
    userId: 1,
    type: "google_sheets",
    status: "active",
    oauthTokenId: 99,
  };

  it("requires both spreadsheetId and sheetName", async () => {
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([healthyRow]),
      params: { spreadsheetId: "abc" },
    });
    await expect(getHeaders(ctx)).rejects.toThrow(/'sheetName' is required/);
  });

  it("returns header labels with columnIndex metadata", async () => {
    vi.mocked(getGoogleSheetHeaders).mockResolvedValue({
      success: true,
      headers: ["Name", "Phone", "Email"],
    });
    const ctx = makeCtx({
      connectionId: 1,
      db: makeDb([healthyRow]),
      params: { spreadsheetId: "abc", sheetName: "Leads" },
    });
    const res = await getHeaders(ctx);
    expect(res.options).toEqual([
      { value: "Name", label: "Name", meta: { columnIndex: 0 } },
      { value: "Phone", label: "Phone", meta: { columnIndex: 1 } },
      { value: "Email", label: "Email", meta: { columnIndex: 2 } },
    ]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

vi.mock("../routes/googleOAuth", () => ({
  getValidGoogleAccessToken: vi.fn(),
}));

import { getDb } from "../db";
import { getValidGoogleAccessToken } from "../routes/googleOAuth";
import { appendLeadToGoogleSheet, buildGoogleSheetsAppendRow } from "./googleSheetsService";

describe("appendLeadToGoogleSheet", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockResolvedValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: 7 }]),
          }),
        }),
      }),
    } as never);
    vi.mocked(getValidGoogleAccessToken).mockResolvedValue("test-access-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success when Sheets API accepts append", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ updates: { updatedRange: "Sheet1!A5:D5" } }), { status: 200 }),
    );

    const out = await appendLeadToGoogleSheet({
      userId: 1,
      googleAccountId: 7,
      spreadsheetId: "abc123",
      sheetName: "Leads",
      values: ["Ann", "+100", "a@b.co", "2026-01-01T00:00:00.000Z"],
    });

    expect(out.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(String(call[0])).toContain("sheets.googleapis.com/v4/spreadsheets/abc123/values/");
    expect(String(call[0])).toContain("valueInputOption=RAW");
    expect(call[1]?.method).toBe("POST");
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body).toEqual({
      values: [["Ann", "+100", "a@b.co", "2026-01-01T00:00:00.000Z"]],
    });
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer test-access-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("returns error when spreadsheetId is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await appendLeadToGoogleSheet({
      userId: 1,
      googleAccountId: 7,
      spreadsheetId: "  ",
      sheetName: "Leads",
      values: ["x"],
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/spreadsheetId/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("buildGoogleSheetsAppendRow uses legacy 4 columns when no sheetHeaders", () => {
    const row = buildGoogleSheetsAppendRow({
      sheetHeaders: null,
      mapping: null,
      leadPayload: {
        leadgenId: "L1",
        fullName: "A",
        phone: "P",
        email: "E",
        pageId: "pg",
        formId: "fm",
      },
      createdAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(row).toEqual(["A", "P", "E", "2026-01-01T00:00:00.000Z"]);
  });

  it("buildGoogleSheetsAppendRow maps by header when mapping provided", () => {
    const row = buildGoogleSheetsAppendRow({
      sheetHeaders: ["Name", "Phone", "Email"],
      mapping: { Name: "fullName", Phone: "phone", Email: "email" },
      leadPayload: {
        leadgenId: "L1",
        fullName: "Ann",
        phone: "+1",
        email: "a@b.co",
        pageId: "p",
        formId: "f",
      },
      createdAtIso: "ISO",
    });
    expect(row).toEqual(["Ann", "+1", "a@b.co"]);
  });

  it("buildGoogleSheetsAppendRow falls back to default order by index when headers but no mapping", () => {
    const row = buildGoogleSheetsAppendRow({
      sheetHeaders: ["A", "B", "C", "D"],
      mapping: {},
      leadPayload: {
        leadgenId: "x",
        fullName: "N",
        phone: "Ph",
        email: "Em",
        pageId: "p",
        formId: "f",
      },
      createdAtIso: "T",
    });
    expect(row).toEqual(["N", "Ph", "Em", "T"]);
  });

  it("returns error on API failure body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid grant", code: 400 } }), { status: 400 }),
    );

    const out = await appendLeadToGoogleSheet({
      userId: 1,
      googleAccountId: 7,
      spreadsheetId: "abc",
      sheetName: "S",
      values: ["1"],
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("Invalid grant");
  });
});

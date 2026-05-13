/**
 * Unit tests for the pure payload builder used by DestinationCreatorDrawer.
 *
 * Covers the dedicated-templateType paths (telegram, google-sheets) and the
 * shared coercion / header-parsing helpers. No React, tRPC, or DOM — the
 * module is 100% pure so vitest in the default node environment is enough.
 *
 * The previous "plain-url (custom webhook)" suite was retired in Phase 4 of
 * the http-refactor along with the plain-url manifest. The universal
 * http-request app's payload is exercised end-to-end by the integration
 * tests in `server/integrations/adapters/httpRequestAdapter.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  APP_KEY_TO_TEMPLATE_TYPE,
  asNumber,
  asString,
  buildCreatePayload,
  isSupportedAppKey,
  parseHeadersJson,
} from "./createPayload";

describe("APP_KEY_TO_TEMPLATE_TYPE / isSupportedAppKey", () => {
  it("maps every supported key to a concrete templateType", () => {
    expect(APP_KEY_TO_TEMPLATE_TYPE.telegram).toBe("telegram");
    expect(APP_KEY_TO_TEMPLATE_TYPE["google-sheets"]).toBe("google-sheets");
    expect(APP_KEY_TO_TEMPLATE_TYPE["http-request"]).toBe("http-request");
  });

  it("narrows unknown keys via isSupportedAppKey", () => {
    expect(isSupportedAppKey("telegram")).toBe(true);
    expect(isSupportedAppKey("google-sheets")).toBe(true);
    expect(isSupportedAppKey("http-request")).toBe(true);
    expect(isSupportedAppKey("plain-url")).toBe(false);
    expect(isSupportedAppKey("unknown")).toBe(false);
    expect(isSupportedAppKey("")).toBe(false);
  });
});

describe("asNumber", () => {
  it("passes through finite numbers", () => {
    expect(asNumber(0)).toBe(0);
    expect(asNumber(42)).toBe(42);
    expect(asNumber(-7)).toBe(-7);
  });

  it("parses trimmed numeric strings", () => {
    expect(asNumber("12")).toBe(12);
    expect(asNumber("  5 ")).toBe(5);
  });

  it("returns undefined for empty, NaN, or non-numeric input", () => {
    expect(asNumber("")).toBeUndefined();
    expect(asNumber("   ")).toBeUndefined();
    expect(asNumber("abc")).toBeUndefined();
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber(undefined)).toBeUndefined();
    expect(asNumber(null)).toBeUndefined();
    expect(asNumber({})).toBeUndefined();
  });
});

describe("asString", () => {
  it("returns strings as-is", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("")).toBe("");
  });

  it("coerces numbers to strings", () => {
    expect(asString(42)).toBe("42");
    expect(asString(0)).toBe("0");
  });

  it("returns empty string for other values", () => {
    expect(asString(undefined)).toBe("");
    expect(asString(null)).toBe("");
    expect(asString(true)).toBe("");
    expect(asString({})).toBe("");
  });
});

describe("parseHeadersJson", () => {
  it("returns undefined for empty input", () => {
    expect(parseHeadersJson("")).toBeUndefined();
    expect(parseHeadersJson("   ")).toBeUndefined();
  });

  it("parses a valid JSON object of string values", () => {
    expect(parseHeadersJson('{"Authorization":"Bearer x","X-Tag":"a"}')).toEqual({
      Authorization: "Bearer x",
      "X-Tag": "a",
    });
  });

  it("rejects non-object JSON", () => {
    expect(() => parseHeadersJson("[]")).toThrow(/expected a JSON object/);
    expect(() => parseHeadersJson('"foo"')).toThrow(/expected a JSON object/);
    expect(() => parseHeadersJson("42")).toThrow(/expected a JSON object/);
    expect(() => parseHeadersJson("null")).toThrow(/expected a JSON object/);
  });

  it("rejects non-string header values", () => {
    expect(() => parseHeadersJson('{"X":1}')).toThrow(/must be a string/);
    expect(() => parseHeadersJson('{"X":null}')).toThrow(/must be a string/);
    expect(() => parseHeadersJson('{"X":{"nested":1}}')).toThrow(
      /must be a string/,
    );
  });

  it("reports JSON parse errors with a descriptive prefix", () => {
    expect(() => parseHeadersJson("{not json")).toThrow(/Invalid headers JSON:/);
  });
});

describe("buildCreatePayload — telegram", () => {
  it("returns the minimum shape when only a connection is provided", () => {
    const payload = buildCreatePayload("telegram", "My bot", {
      connectionId: 42,
    });
    expect(payload).toEqual({
      name: "My bot",
      appKey: "telegram",
      connectionId: 42,
    });
  });

  it("accepts chatId and messageTemplate when present", () => {
    const payload = buildCreatePayload("telegram", "Sales", {
      connectionId: "7",
      chatId: "  -100123  ",
      messageTemplate: "Hi {{full_name}}",
    });
    expect(payload).toEqual({
      name: "Sales",
      appKey: "telegram",
      connectionId: 7,
      chatId: "-100123",
      messageTemplate: "Hi {{full_name}}",
    });
  });

  it("throws when no connection is selected", () => {
    expect(() => buildCreatePayload("telegram", "x", {})).toThrow(
      /Telegram connection/i,
    );
    expect(() =>
      buildCreatePayload("telegram", "x", { connectionId: "" }),
    ).toThrow(/Telegram connection/i);
  });

  it("omits chatId when it is just whitespace", () => {
    const payload = buildCreatePayload("telegram", "x", {
      connectionId: 1,
      chatId: "   ",
    });
    expect(payload).not.toHaveProperty("chatId");
  });
});

describe("buildCreatePayload — google-sheets", () => {
  it("requires connectionId, spreadsheetId, and sheetName", () => {
    expect(() =>
      buildCreatePayload("google-sheets", "x", {
        spreadsheetId: "abc",
        sheetName: "Sheet1",
      }),
    ).toThrow(/Google account/i);

    expect(() =>
      buildCreatePayload("google-sheets", "x", {
        connectionId: 1,
        sheetName: "Sheet1",
      }),
    ).toThrow(/Spreadsheet is required/);

    expect(() =>
      buildCreatePayload("google-sheets", "x", {
        connectionId: 1,
        spreadsheetId: "abc",
      }),
    ).toThrow(/Sheet tab is required/);
  });

  it("builds sheetHeaders from mapping keys and preserves mapping", () => {
    const payload = buildCreatePayload("google-sheets", "Leads", {
      connectionId: 9,
      spreadsheetId: "  spread_id  ",
      sheetName: "  Sheet1  ",
      mapping: { "Full Name": "full_name", Phone: "phone_number" },
    });
    expect(payload).toEqual({
      name: "Leads",
      appKey: "google-sheets",
      connectionId: 9,
      spreadsheetId: "spread_id",
      sheetName: "Sheet1",
      mapping: { "Full Name": "full_name", Phone: "phone_number" },
      sheetHeaders: ["Full Name", "Phone"],
    });
  });

  it("treats missing mapping as an empty object", () => {
    const payload = buildCreatePayload("google-sheets", "x", {
      connectionId: 1,
      spreadsheetId: "s",
      sheetName: "t",
    });
    if (payload.appKey !== "google-sheets") {
      throw new Error("expected google-sheets payload");
    }
    expect(payload.mapping).toEqual({});
    expect(payload.sheetHeaders).toEqual([]);
  });
});

describe("buildCreatePayload — unsupported apps", () => {
  it("throws for unknown app keys", () => {
    expect(() => buildCreatePayload("shopify", "x", {})).toThrow(
      /Unsupported app/,
    );
    expect(() => buildCreatePayload("", "x", {})).toThrow(/Unsupported app/);
  });
});

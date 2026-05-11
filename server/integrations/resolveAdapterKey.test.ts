import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveAdapterKey } from "./resolveAdapterKey";

describe("resolveAdapterKey — Stage 2 appKey", () => {
  const orig = process.env.STAGE2_ADAPTER_LOG;

  afterEach(() => {
    if (orig === undefined) delete process.env.STAGE2_ADAPTER_LOG;
    else process.env.STAGE2_ADAPTER_LOG = orig;
  });

  it("AFFILIATE returns affiliate regardless of tw", () => {
    expect(
      resolveAdapterKey("AFFILIATE", { templateId: 1, templateType: "custom", appKey: "mgoods" }),
    ).toBe("affiliate");
  });

  it("LEAD no tw -> plain-url", () => {
    expect(resolveAdapterKey("LEAD_ROUTING", null)).toBe("plain-url");
  });

  it("LEAD NEW: appKey mgoods -> dynamic-template (affiliate app)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", {
        templateId: 5,
        templateType: "custom",
        appKey: "mgoods",
      }),
    ).toBe("dynamic-template");
  });

  it("LEAD NEW: appKey telegram", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "telegram", appKey: "telegram" }),
    ).toBe("telegram");
  });

  it("LEAD NEW: appKey google-sheets", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "google-sheets", appKey: "google-sheets" }),
    ).toBe("google-sheets");
  });

  it("LEAD NEW: appKey google_sheets alias → same adapter as google-sheets", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: 1, templateType: "custom", appKey: "google_sheets" }),
    ).toBe("google-sheets");
  });

  // ── Sprint 4 / Item 4.3: templateType-first legacy fallback sunset ──────
  //
  // The block below previously implemented "if appKey is missing, route by
  // templateType". That fallback was removed after auditing both local and
  // production target_websites tables (audit-appkey-coverage.ts) and
  // confirming 0 rows had a null or 'unknown' appKey. Tests now document
  // the post-sunset behaviour: appKey is mandatory, anything without one
  // (or with the `unknown` backfill sentinel) falls into the safe
  // plain-url default.
  it("LEAD: missing appKey → plain-url default (4.3 sunset)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: 7, templateType: "custom", appKey: null }),
    ).toBe("plain-url");
  });

  it("LEAD: missing appKey + no templateId → plain-url (4.3 sunset)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "sotuvchi", appKey: null }),
    ).toBe("plain-url");
  });

  it("LEAD: appKey='unknown' sentinel → plain-url (4.3 sunset)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", {
        templateId: null,
        templateType: "sotuvchi",
        appKey: "unknown",
      }),
    ).toBe("plain-url");
  });

  it("LEAD: templateType=telegram without appKey → plain-url (4.3 sunset)", () => {
    // templateType is no longer a routing signal. Setting the appKey is
    // mandatory for any destination type the system knows about.
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "telegram", appKey: null }),
    ).toBe("plain-url");
  });

  it("STAGE2_ADAPTER_LOG logs when set", () => {
    process.env.STAGE2_ADAPTER_LOG = "1";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveAdapterKey("LEAD_ROUTING", { templateId: 1, appKey: "x" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

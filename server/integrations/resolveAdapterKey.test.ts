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

  it("LEAD LEGACY: no appKey, templateId set -> dynamic-template", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: 7, templateType: "custom", appKey: null }),
    ).toBe("dynamic-template");
  });

  it("LEAD LEGACY: no appKey, sotuvchi no templateId -> legacy-template", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "sotuvchi", appKey: null }),
    ).toBe("legacy-template");
  });

  it("NOT NULL backfill: appKey unknown → same routing as missing (legacy path by templateType)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", {
        templateId: null,
        templateType: "sotuvchi",
        appKey: "unknown",
      }),
    ).toBe("legacy-template");
  });

  it("LEAD LEGACY: no appKey, templateType telegram", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "telegram", appKey: null }),
    ).toBe("telegram");
  });

  // Regression guard: telegram/sheets with BOTH templateType AND templateId set must NOT go to dynamic-template.
  // Before the fix the templateId check fired first, silently misrouting messaging destinations.
  it("REGRESSION: telegram + templateId set → still telegram (not dynamic-template)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: 99, templateType: "telegram", appKey: null }),
    ).toBe("telegram");
  });

  it("REGRESSION: google-sheets + templateId set → still google-sheets (not dynamic-template)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: 99, templateType: "google-sheets", appKey: null }),
    ).toBe("google-sheets");
  });

  it("STAGE2_ADAPTER_LOG logs when set", () => {
    process.env.STAGE2_ADAPTER_LOG = "1";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveAdapterKey("LEAD_ROUTING", { templateId: 1, appKey: "x" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

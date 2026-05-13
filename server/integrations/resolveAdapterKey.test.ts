import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveAdapterKey } from "./resolveAdapterKey";

describe("resolveAdapterKey — Stage 2 appKey", () => {
  const orig = process.env.STAGE2_ADAPTER_LOG;

  afterEach(() => {
    if (orig === undefined) delete process.env.STAGE2_ADAPTER_LOG;
    else process.env.STAGE2_ADAPTER_LOG = orig;
  });

  it("LEAD no tw -> http-request", () => {
    expect(resolveAdapterKey("LEAD_ROUTING", null)).toBe("http-request");
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

  it("LEAD: non-first-party appKey without templateId -> dynamic-template (post legacy-template sunset)", () => {
    // Previously this case routed to "legacy-template". After the
    // 2026-05-12 audit (0 production rows match) the legacy-template
    // fallback was removed; any non-first-party appKey now lands on
    // dynamic-template, which will surface a structured validation
    // error if no template can be loaded.
    expect(
      resolveAdapterKey("LEAD_ROUTING", {
        templateId: null,
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
  // production destinations tables (audit-appkey-coverage.ts) and
  // confirming 0 rows had a null or 'unknown' appKey. Tests now document
  // the post-sunset behaviour: appKey is mandatory, anything without one
  // (or with the `unknown` backfill sentinel) falls into the safe
  // http-request default (was plain-url before Phase 4 retired it).
  it("LEAD: missing appKey → http-request default (4.3 sunset)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: 7, templateType: "custom", appKey: null }),
    ).toBe("http-request");
  });

  it("LEAD: missing appKey + no templateId → http-request (4.3 sunset)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "sotuvchi", appKey: null }),
    ).toBe("http-request");
  });

  it("LEAD: appKey='unknown' sentinel → http-request (4.3 sunset)", () => {
    expect(
      resolveAdapterKey("LEAD_ROUTING", {
        templateId: null,
        templateType: "sotuvchi",
        appKey: "unknown",
      }),
    ).toBe("http-request");
  });

  it("LEAD: templateType=telegram without appKey → http-request (4.3 sunset)", () => {
    // templateType is no longer a routing signal. Setting the appKey is
    // mandatory for any destination type the system knows about.
    expect(
      resolveAdapterKey("LEAD_ROUTING", { templateId: null, templateType: "telegram", appKey: null }),
    ).toBe("http-request");
  });

  it("STAGE2_ADAPTER_LOG logs when set", () => {
    process.env.STAGE2_ADAPTER_LOG = "1";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveAdapterKey("LEAD_ROUTING", { templateId: 1, appKey: "x" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyGraphError,
  computeLeadNextRetryAt,
  LEAD_MAX_GRAPH_ATTEMPTS,
} from "./leadEnrichmentRetryPolicy";

// ─── classifyGraphError ───────────────────────────────────────────────────

describe("classifyGraphError", () => {
  it("classifies code 100 subcode 33 as permanently_missing", () => {
    expect(
      classifyGraphError({ fbErrorCode: 100, fbErrorSubcode: 33, message: "Object does not exist" }),
    ).toBe("permanently_missing");
  });

  it("classifies 'does not exist' messages without subcode as permanently_missing", () => {
    expect(
      classifyGraphError({ fbErrorCode: 100, message: "Unsupported get request. Object with ID '123' does not exist" }),
    ).toBe("permanently_missing");
  });

  it("classifies code 190 (token issues) as auth", () => {
    expect(
      classifyGraphError({ fbErrorCode: 190, message: "Invalid OAuth access token" }),
    ).toBe("auth");
  });

  it("classifies HTTP 401 as auth even without FB code", () => {
    expect(
      classifyGraphError({ httpStatus: 401, message: "Unauthorized" }),
    ).toBe("auth");
  });

  it("classifies code 4 (app rate limit) as rate_limit", () => {
    expect(
      classifyGraphError({ fbErrorCode: 4, message: "Application request limit reached" }),
    ).toBe("rate_limit");
  });

  it("classifies HTTP 429 as rate_limit", () => {
    expect(
      classifyGraphError({ httpStatus: 429, message: "Too Many Requests" }),
    ).toBe("rate_limit");
  });

  it("classifies HTTP 400 as validation", () => {
    expect(
      classifyGraphError({ httpStatus: 400, message: "Bad Request" }),
    ).toBe("validation");
  });

  it("falls back to network for transient errors", () => {
    expect(
      classifyGraphError({ httpStatus: 502, message: "Bad Gateway" }),
    ).toBe("network");
    expect(
      classifyGraphError({ message: "ETIMEDOUT" }),
    ).toBe("network");
  });

  it("falls back to network for unknown shapes (better over-retry than over-giveup)", () => {
    expect(classifyGraphError({ message: "weird thing" })).toBe("network");
    expect(classifyGraphError({})).toBe("network");
  });
});

// ─── computeLeadNextRetryAt ───────────────────────────────────────────────

describe("computeLeadNextRetryAt", () => {
  const now = new Date("2026-05-13T12:00:00.000Z");

  it("returns null on success", () => {
    expect(
      computeLeadNextRetryAt({ now, newAttempts: 1, success: true }),
    ).toBeNull();
  });

  it("returns null when attempts >= max", () => {
    expect(
      computeLeadNextRetryAt({
        now,
        newAttempts: LEAD_MAX_GRAPH_ATTEMPTS,
        success: false,
        errorType: "network",
      }),
    ).toBeNull();
  });

  it("returns null for permanently_missing — gives up forever", () => {
    expect(
      computeLeadNextRetryAt({ now, newAttempts: 1, success: false, errorType: "permanently_missing" }),
    ).toBeNull();
  });

  it("returns null for validation — gives up forever", () => {
    expect(
      computeLeadNextRetryAt({ now, newAttempts: 1, success: false, errorType: "validation" }),
    ).toBeNull();
  });

  it("auth gets one follow-up retry then null", () => {
    const first = computeLeadNextRetryAt({ now, newAttempts: 1, success: false, errorType: "auth" });
    expect(first).not.toBeNull();
    expect(
      computeLeadNextRetryAt({ now, newAttempts: 2, success: false, errorType: "auth" }),
    ).toBeNull();
  });

  it("network uses exponential ladder", () => {
    const first = computeLeadNextRetryAt({ now, newAttempts: 1, success: false, errorType: "network" });
    const second = computeLeadNextRetryAt({ now, newAttempts: 2, success: false, errorType: "network" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // 2nd retry is later than 1st (15m > 5m)
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it("rate_limit honours retryAfterMs when provided", () => {
    const provider = computeLeadNextRetryAt({
      now,
      newAttempts: 1,
      success: false,
      errorType: "rate_limit",
      retryAfterMs: 60 * 1000,
    });
    expect(provider).not.toBeNull();
    expect(provider!.getTime() - now.getTime()).toBe(60 * 1000);
  });

  it("rate_limit floor is 15 minutes when no retryAfterMs", () => {
    const rl = computeLeadNextRetryAt({
      now,
      newAttempts: 1,
      success: false,
      errorType: "rate_limit",
    });
    expect(rl).not.toBeNull();
    expect(rl!.getTime() - now.getTime()).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  it("clamps absurd retryAfterMs to 6h max", () => {
    const r = computeLeadNextRetryAt({
      now,
      newAttempts: 1,
      success: false,
      errorType: "network",
      retryAfterMs: 999 * 60 * 60 * 1000, // 999 hours
    });
    expect(r).not.toBeNull();
    expect(r!.getTime() - now.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it("clamps absurdly small retryAfterMs to 1s min", () => {
    const r = computeLeadNextRetryAt({
      now,
      newAttempts: 1,
      success: false,
      errorType: "network",
      retryAfterMs: 100, // 100ms
    });
    expect(r).not.toBeNull();
    expect(r!.getTime() - now.getTime()).toBe(1000);
  });

  it("falls back to legacy fixed delay when errorType is undefined", () => {
    const r = computeLeadNextRetryAt({ now, newAttempts: 1, success: false });
    expect(r).not.toBeNull();
    expect(r!.getTime() - now.getTime()).toBeGreaterThan(0);
  });
});

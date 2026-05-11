import { describe, expect, it } from "vitest";
import { checkPhone, syntheticInvalidPhoneResult } from "./phoneValidation";

// Real prod failure samples from Railway 100k.uz 422 logs.
describe("checkPhone — real prod 422 samples", () => {
  it("accepts well-formed UZ number", () => {
    expect(checkPhone("+998978164224")).toEqual({ valid: true });
  });

  it("accepts international numbers (we delegate strict country checks to partners)", () => {
    expect(checkPhone("+79049124112")).toEqual({ valid: true });    // Russia
    expect(checkPhone("+77051949692")).toEqual({ valid: true });    // Kazakhstan
    expect(checkPhone("+93337041616")).toEqual({ valid: true });    // Afghanistan
    expect(checkPhone("+989905561081")).toEqual({ valid: true });   // Iran
  });

  it("rejects 17-digit garbage", () => {
    // Real prod data — Railway order 7031987
    expect(checkPhone("+9992023509168874")).toEqual({ valid: false, reason: "too_long" });
  });

  it("rejects truncated numbers", () => {
    expect(checkPhone("123")).toEqual({ valid: false, reason: "too_short" });
    expect(checkPhone("+99")).toEqual({ valid: false, reason: "too_short" });
  });

  it("rejects empty / null / whitespace", () => {
    expect(checkPhone(null)).toEqual({ valid: false, reason: "empty" });
    expect(checkPhone(undefined)).toEqual({ valid: false, reason: "empty" });
    expect(checkPhone("")).toEqual({ valid: false, reason: "empty" });
    expect(checkPhone("   ")).toEqual({ valid: false, reason: "empty" });
  });

  it("rejects strings with no digits at all", () => {
    expect(checkPhone("abc-def-ghij")).toEqual({ valid: false, reason: "no_digits" });
  });

  it("accepts numbers with formatting characters", () => {
    expect(checkPhone("+998 (97) 816-42-24")).toEqual({ valid: true });
    expect(checkPhone("8 (773) 589-9491")).toEqual({ valid: true });
  });
});

describe("syntheticInvalidPhoneResult", () => {
  it("returns a failure DeliveryResult shape with validation errorType", () => {
    const r = syntheticInvalidPhoneResult("too_long");
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("validation");
    expect(r.error).toContain("too_long");
    expect(r.durationMs).toBe(0);
  });
});

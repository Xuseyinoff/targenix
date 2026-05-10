import { describe, expect, it } from "vitest";
import { extractExternalOrderId } from "./extractExternalOrderId";

describe("extractExternalOrderId", () => {
  it("reads Sotuvchi-style top-level id", () => {
    expect(extractExternalOrderId({ ok: "true", id: 694147 })).toBe("694147");
  });

  it("reads 100k data.id", () => {
    expect(extractExternalOrderId({ data: { id: "abc-123" } })).toBe("abc-123");
  });

  it("reads nested data.data.id", () => {
    expect(extractExternalOrderId({ data: { data: { id: "n1" } } })).toBe("n1");
  });

  it("reads wrapped axios body", () => {
    expect(
      extractExternalOrderId({ body: { data: { id: "wrapped" } }, attempts: 1 }),
    ).toBe("wrapped");
  });

  it("reads order.id", () => {
    expect(extractExternalOrderId({ order: { id: 99 } })).toBe("99");
  });

  it("reads order_id fallback", () => {
    expect(extractExternalOrderId({ order_id: "x" })).toBe("x");
  });
});

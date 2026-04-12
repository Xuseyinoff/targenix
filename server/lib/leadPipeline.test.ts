import { describe, it, expect } from "vitest";
import { aggregateDeliveryStatus } from "./leadPipeline";

describe("aggregateDeliveryStatus", () => {
  it("returns SUCCESS when no integrations ran", () => {
    expect(aggregateDeliveryStatus([])).toBe("SUCCESS");
  });

  it("returns SUCCESS when all SENT", () => {
    expect(aggregateDeliveryStatus(["SENT", "SENT"])).toBe("SUCCESS");
  });

  it("returns FAILED when all FAILED", () => {
    expect(aggregateDeliveryStatus(["FAILED", "FAILED"])).toBe("FAILED");
  });

  it("returns PARTIAL on mix", () => {
    expect(aggregateDeliveryStatus(["SENT", "FAILED"])).toBe("PARTIAL");
  });
});

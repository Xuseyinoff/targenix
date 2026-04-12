import { describe, it, expect } from "vitest";
import { aggregateDeliveryStatus, aggregateLeadDeliveryFromOrderStatuses } from "./leadPipeline";

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

describe("aggregateLeadDeliveryFromOrderStatuses", () => {
  it("returns SUCCESS when there are no order rows", () => {
    expect(aggregateLeadDeliveryFromOrderStatuses([])).toBe("SUCCESS");
  });

  it("returns PROCESSING when any order is PENDING", () => {
    expect(aggregateLeadDeliveryFromOrderStatuses(["PENDING", "SENT"])).toBe("PROCESSING");
  });

  it("returns SUCCESS when all SENT", () => {
    expect(aggregateLeadDeliveryFromOrderStatuses(["SENT", "SENT"])).toBe("SUCCESS");
  });

  it("returns FAILED when all FAILED", () => {
    expect(aggregateLeadDeliveryFromOrderStatuses(["FAILED", "FAILED"])).toBe("FAILED");
  });

  it("returns PARTIAL on SENT/FAILED mix with no PENDING", () => {
    expect(aggregateLeadDeliveryFromOrderStatuses(["SENT", "FAILED"])).toBe("PARTIAL");
  });
});

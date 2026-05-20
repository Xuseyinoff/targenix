import { describe, expect, it } from "vitest";
import {
  mapHundredKRawToNormalized,
  mapSotuvchiRawToNormalized,
  isFinalStatus,
  classifyStatus,
  FINAL_STATUSES,
} from "./crmStatuses";

// All raw status values observed via the 100k.uz partner API (verified
// 2026-05-20 — see tooling/probe-100k-api-direct.mjs). Add new values here
// when probes surface them; a missing mapping silently maps to 'unknown'.
const HUNDREDK_OBSERVED_IN_PROD: ReadonlyArray<[string, string]> = [
  ["new", "new"],
  ["accepted", "contacted"],
  ["booked", "in_progress"],
  ["sent", "sent"],
  ["callback", "callback"],
  ["sold", "success"],
  ["delivered", "delivered"],
  ["cancelled", "cancelled"],
  ["archived", "archived"],
];

// Variants the API may emit (lookup-only — not yet observed in our prod
// distribution but documented by 100k.uz / mirrored from Sotuvchi).
const HUNDREDK_DEFENSIVE_VARIANTS: ReadonlyArray<[string, string]> = [
  ["request", "new"],
  ["filling", "contacted"],
  ["order", "contacted"],
  ["preparing", "in_progress"],
  ["canceled", "cancelled"],
  ["product_out_of_stock", "out_of_stock"],
  ["client_returned", "returned"],
  ["not_delivered", "not_delivered"],
  ["trash", "trash"],
  ["not_sold", "not_sold"],
  ["not_sold_group", "not_sold"],
];

describe("mapHundredKRawToNormalized — observed-in-prod mapping pins", () => {
  for (const [raw, expected] of HUNDREDK_OBSERVED_IN_PROD) {
    it(`'${raw}' → '${expected}'`, () => {
      expect(mapHundredKRawToNormalized(raw)).toBe(expected);
    });
  }
});

describe("mapHundredKRawToNormalized — defensive variants", () => {
  for (const [raw, expected] of HUNDREDK_DEFENSIVE_VARIANTS) {
    it(`'${raw}' → '${expected}'`, () => {
      expect(mapHundredKRawToNormalized(raw)).toBe(expected);
    });
  }
});

describe("mapHundredKRawToNormalized — case + whitespace tolerance", () => {
  it("uppercase folds to canonical", () => {
    expect(mapHundredKRawToNormalized("DELIVERED")).toBe("delivered");
    expect(mapHundredKRawToNormalized(" Archived ")).toBe("archived");
  });

  it("empty string maps to 'new' (sane default for fresh leads)", () => {
    expect(mapHundredKRawToNormalized("")).toBe("new");
  });

  it("unknown values fall through to 'unknown'", () => {
    expect(mapHundredKRawToNormalized("brand_new_status_2030")).toBe("unknown");
  });
});

describe("isFinalStatus — terminal classification", () => {
  it("delivered is final", () => expect(isFinalStatus("delivered")).toBe(true));
  it("cancelled is final", () => expect(isFinalStatus("cancelled")).toBe(true));
  it("archived is final", () => expect(isFinalStatus("archived")).toBe(true));
  it("trash is final", () => expect(isFinalStatus("trash")).toBe(true));

  it("not_delivered is NOT final (retry-able per 2026-05-15 sotuvchi probe)", () =>
    expect(isFinalStatus("not_delivered")).toBe(false));
  it("sent is not final", () => expect(isFinalStatus("sent")).toBe(false));
  it("new is not final", () => expect(isFinalStatus("new")).toBe(false));
});

describe("FINAL_STATUSES set guards against silent drops", () => {
  // Pin the exact size. Adding/removing terminals is a behavior change that
  // must update this test (and a follow-up to backfill if removing).
  it("has exactly 6 terminal statuses", () => {
    expect(FINAL_STATUSES.size).toBe(6);
  });

  it("contains all expected terminals", () => {
    for (const s of ["delivered", "cancelled", "returned", "trash", "not_sold", "archived"]) {
      expect(FINAL_STATUSES.has(s)).toBe(true);
    }
  });
});

describe("classifyStatus — poll-cadence tier", () => {
  it("delivered → FINAL", () => expect(classifyStatus("delivered")).toBe("FINAL"));
  it("new → ACTIVE", () => expect(classifyStatus("new")).toBe("ACTIVE"));
  it("contacted → ACTIVE", () => expect(classifyStatus("contacted")).toBe("ACTIVE"));
  it("in_progress → MID", () => expect(classifyStatus("in_progress")).toBe("MID"));
  it("unknown → MID", () => expect(classifyStatus("unknown")).toBe("MID"));
  it("null → ACTIVE (never-synced rows poll fast)", () =>
    expect(classifyStatus(null)).toBe("ACTIVE"));
});

describe("Sotuvchi mapping — sanity (verified 2026-05-15 against live API)", () => {
  it("'sent' → 'sent'", () =>
    expect(mapSotuvchiRawToNormalized("sent")).toBe("sent"));
  it("'sold' → 'success'", () =>
    expect(mapSotuvchiRawToNormalized("sold")).toBe("success"));
  it("'delivered' → 'delivered'", () =>
    expect(mapSotuvchiRawToNormalized("delivered")).toBe("delivered"));
});

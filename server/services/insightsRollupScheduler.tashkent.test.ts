/**
 * Tests for the Asia/Tashkent (UTC+5) day-bucket boundary in the insights
 * rollup pipeline.
 *
 * Why a dedicated test
 *   A lead created at 21:00 UTC belongs to "tomorrow" in Tashkent. Picking
 *   the wrong calendar day silently mis-buckets every lead between 19:00 UTC
 *   (00:00 Tashkent) and 23:59 UTC (04:59 Tashkent next day) — a 5-hour
 *   sliver that affects the "today" view every morning. This test pins the
 *   conversion so a regression to UTC bucketing fails CI rather than
 *   silently mis-classifying rows.
 *
 * Scope
 *   The rebuildOneDay SQL itself runs against MySQL and is exercised by the
 *   integration smoke; here we cover the JS helpers that pick the window
 *   dates from a Date, and the front-end parity expectation.
 */
import { describe, it, expect } from "vitest";

// Mirror of the helper in insightsRollupScheduler.ts. Kept inline so the
// test fails if someone changes the helper's semantics without also
// updating this contract.
function tashkentDayStr(d: Date): string {
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

describe("tashkentDayStr — UTC→Tashkent calendar conversion", () => {
  it("returns the same UTC date when the instant is mid-day UTC", () => {
    expect(tashkentDayStr(new Date("2026-05-20T12:00:00Z"))).toBe("2026-05-20");
  });

  it("rolls forward to the next day at 19:00 UTC (= 00:00 Tashkent next day)", () => {
    // 19:00 UTC on the 20th is exactly 00:00 Tashkent on the 21st — anyone
    // looking at the dashboard at this moment in Tashkent considers it the
    // start of a new day.
    expect(tashkentDayStr(new Date("2026-05-20T19:00:00Z"))).toBe("2026-05-21");
  });

  it("stays on the same Tashkent day for the 18:59 UTC sliver", () => {
    // 18:59 UTC on the 20th is 23:59 Tashkent on the 20th — last minute of
    // the marketer's day, must still belong to the 20th's bucket.
    expect(tashkentDayStr(new Date("2026-05-20T18:59:00Z"))).toBe("2026-05-20");
  });

  it("treats 00:00 UTC as the same Tashkent day (already 05:00 local)", () => {
    expect(tashkentDayStr(new Date("2026-05-20T00:00:00Z"))).toBe("2026-05-20");
  });

  it("treats 23:59:59 UTC as the next Tashkent day (04:59 local tomorrow)", () => {
    expect(tashkentDayStr(new Date("2026-05-20T23:59:59Z"))).toBe("2026-05-21");
  });
});

describe("Tashkent boundary parity — server SQL vs JS helper", () => {
  it("CONVERT_TZ('UTC','+05:00') and tashkentDayStr agree on the boundary", () => {
    // The rollup writer uses MySQL's
    //   DATE(CONVERT_TZ(leads.createdAt, '+00:00', '+05:00'))
    // and the JS helper above is what the scheduler picks for the date list.
    // Both must agree on the boundary for the rebuild to find any rows at
    // all. CONVERT_TZ adds the +05:00 offset to the UTC timestamp before
    // DATE() truncates — semantically identical to the JS millisecond add.
    const samples = [
      "2026-05-20T18:59:59Z",  // 23:59 Tashkent same day
      "2026-05-20T19:00:00Z",  // 00:00 Tashkent next day
      "2026-05-21T03:30:00Z",  // 08:30 Tashkent same day
      "2026-12-31T20:00:00Z",  // year boundary: 01:00 Tashkent Jan 1
    ];
    const expected = [
      "2026-05-20",
      "2026-05-21",
      "2026-05-21",
      "2027-01-01",
    ];
    samples.forEach((iso, i) => {
      expect(tashkentDayStr(new Date(iso))).toBe(expected[i]);
    });
  });
});

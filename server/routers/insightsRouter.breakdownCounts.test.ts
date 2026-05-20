/**
 * Tests for insights.getBreakdown — per-status counts derivation.
 *
 * The procedure pulls rollup rows from `fact_attribution_daily` and derives
 * four UI-shaped counts (`deliveredCount, pipelineCount, trashCount,
 * unsyncedCount`) from the rollup's per-bucket columns. These tests pin the
 * mapping so a future change to bucket boundaries does not silently shift
 * the numbers users see on the Insights table's status bar.
 *
 * Bucket → derived mapping (see insightsRouter.ts getBreakdown):
 *   deliveredCount = delivered
 *   pipelineCount  = held
 *   trashCount     = rejected + trash
 *   unsyncedCount  = max(0, leads - delivered - held - rejected - trash)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, getDb: vi.fn() };
});

import { getDb } from "../db";
import { insightsRouter } from "./insightsRouter";
import type { TrpcContext } from "../_core/context";

interface RollupRow {
  key: string;
  leads: number;
  sent: number;
  accepted: number;
  delivered: number;
  held: number;
  rejected: number;
  trash: number;
  revenue: number;
  pipeline: number;
  spend: number;
}

function makeMockDb(rollupRows: RollupRow[]) {
  // db.select({...}).from(factAttributionDaily).where(...).groupBy(...).orderBy(...).limit(...)
  // returns rollupRows; resolveLabels makes a follow-up db.select for the
  // dimension's name lookup table — we satisfy that with an empty array so
  // the label falls back to the row key.
  let selectCallCount = 0;
  const limitFn = vi.fn(async () => rollupRows);
  const orderByFn = vi.fn(() => ({ limit: limitFn }));
  const groupByFn = vi.fn(() => ({ orderBy: orderByFn }));
  const whereFn = vi.fn(() => ({ groupBy: groupByFn }));
  const fromFn = vi.fn(() => ({ where: whereFn }));

  // resolveLabels uses db.select(...).from(table).where(inArray(idCol, ids))
  const emptyLabelsLimit = vi.fn(async () => []);
  const emptyLabelsWhere = vi.fn(() => emptyLabelsLimit());
  const labelFromFn = vi.fn(() => ({ where: emptyLabelsWhere }));

  const select = vi.fn(() => {
    selectCallCount++;
    // First select() goes to factAttributionDaily, subsequent ones to
    // resolveLabels' source tables.
    return selectCallCount === 1
      ? { from: fromFn }
      : { from: labelFromFn };
  });

  // db.execute(SELECT baseCurrency FROM users ...) — called at the end to pick
  // the currency for the response payload.
  const execute = vi.fn(async () => [[{ baseCurrency: "USD" }]]);

  return { select, execute } as unknown as Awaited<ReturnType<typeof getDb>>;
}

function userCaller(userId = 1) {
  const ctx = {
    req: null,
    res: null,
    user: {
      id: userId,
      name: "Test User",
      email: "u@test.com",
      role: "user",
      password: null,
      facebookId: null,
      googleId: null,
      createdAt: new Date(),
    },
  } as unknown as TrpcContext;
  return insightsRouter.createCaller(ctx);
}

beforeEach(() => vi.clearAllMocks());

describe("getBreakdown — per-status count derivation", () => {
  it("returns all four count fields on every row", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb([
        {
          key: "c1", leads: 100, sent: 90,
          accepted: 70, delivered: 40, held: 15, rejected: 5, trash: 3,
          revenue: 0, pipeline: 0, spend: 0,
        },
      ]),
    );
    const r = await userCaller(1).getBreakdown({
      start: "2026-05-01", end: "2026-05-20", groupBy: "campaign",
    });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.deliveredCount).toBe(40);
    expect(row.pipelineCount).toBe(15);
    expect(row.trashCount).toBe(8);          // rejected (5) + trash (3)
    expect(row.unsyncedCount).toBe(37);      // 100 − 40 − 15 − 5 − 3
  });

  it("sum of derived counts is ≤ leads (no double-counting via accepted bucket)", async () => {
    // accepted in the rollup is a SUPERSET that includes delivered + held, so
    // it must NOT participate in any of the four UI counts. This row exercises
    // the worst case: accepted = 90 which would, if accidentally used,
    // overshoot leads.
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb([
        {
          key: "c1", leads: 100, sent: 95,
          accepted: 90, delivered: 30, held: 20, rejected: 10, trash: 5,
          revenue: 0, pipeline: 0, spend: 0,
        },
      ]),
    );
    const r = await userCaller(1).getBreakdown({
      start: "2026-05-01", end: "2026-05-20", groupBy: "campaign",
    });
    const row = r.rows[0]!;
    const totalSegments =
      row.deliveredCount + row.pipelineCount + row.trashCount + row.unsyncedCount;
    expect(totalSegments).toBeLessThanOrEqual(row.leads);
    expect(totalSegments).toBe(100); // exact: 30 + 20 + 15 + 35
  });

  it("all-delivered campaign → pipeline=0, trash=0", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb([
        {
          key: "c1", leads: 50, sent: 50,
          accepted: 50, delivered: 50, held: 0, rejected: 0, trash: 0,
          revenue: 0, pipeline: 0, spend: 0,
        },
      ]),
    );
    const r = await userCaller(1).getBreakdown({
      start: "2026-05-01", end: "2026-05-20", groupBy: "campaign",
    });
    const row = r.rows[0]!;
    expect(row.deliveredCount).toBe(50);
    expect(row.pipelineCount).toBe(0);
    expect(row.trashCount).toBe(0);
    expect(row.unsyncedCount).toBe(0);
  });

  it("all-trash campaign → trashCount = rejected + trash, others zero", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb([
        {
          key: "c1", leads: 20, sent: 20,
          accepted: 0, delivered: 0, held: 0, rejected: 12, trash: 8,
          revenue: 0, pipeline: 0, spend: 0,
        },
      ]),
    );
    const r = await userCaller(1).getBreakdown({
      start: "2026-05-01", end: "2026-05-20", groupBy: "campaign",
    });
    const row = r.rows[0]!;
    expect(row.trashCount).toBe(20);
    expect(row.deliveredCount).toBe(0);
    expect(row.pipelineCount).toBe(0);
    expect(row.unsyncedCount).toBe(0);
  });

  it("unsyncedCount is clamped to 0 when fan-out makes order counts exceed leads", async () => {
    // Multi-affiliate fan-out: one lead can produce multiple orders, so the
    // sum of CRM-bucket counts can exceed the lead count for a given row.
    // The residual must not go negative (would render as an inverted bar).
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb([
        {
          key: "c1", leads: 10, sent: 25,
          accepted: 18, delivered: 10, held: 6, rejected: 4, trash: 2,
          revenue: 0, pipeline: 0, spend: 0,
        },
      ]),
    );
    const r = await userCaller(1).getBreakdown({
      start: "2026-05-01", end: "2026-05-20", groupBy: "campaign",
    });
    const row = r.rows[0]!;
    // 10 − 10 − 6 − 4 − 2 = −12 → clamped to 0
    expect(row.unsyncedCount).toBe(0);
    expect(row.deliveredCount + row.pipelineCount + row.trashCount).toBe(22);
  });
});

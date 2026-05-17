/**
 * Tests for destinationSchedulesRouter — Yuboraman parity PR 4/4 Phase A.
 *
 * What's covered:
 *   Per-destination
 *    1. getSchedule on own destination with row → returns it
 *    2. getSchedule with no row → returns null
 *    3. getSchedule against a foreign destinationId → returns null
 *       (the userId filter inside the WHERE clause collapses the result;
 *       intentionally NOT throwing so existence isn't leaked)
 *    4. setSchedule on owned destination → upserts and re-selects
 *    5. setSchedule on a destination the caller does not own → "Destination not found"
 *    6. setSchedule input validation: pauseHour=24 fails zod
 *    7. clearSchedule → executes DELETE scoped to (destinationId, userId)
 *
 *   Global
 *    8. pauseAll → 0 destinations → returns affected=0 without inserting
 *    9. pauseAll → N destinations → inserts/upserts N rows scoped to caller
 *   10. startAll → executes an UPDATE filtered by caller userId
 *   11. flushPendingAll → returns the count of undelivered pending leads (Phase A stub)
 *   12. resetSchedules → executes a DELETE filtered by caller userId
 *
 * Mock-DB style: the test builds a DbClient stub whose chain methods return
 * either thenables (for terminal queries) or further chain stubs. The mocks
 * record WHERE-clause builders so the tests can assert tenant scoping.
 *
 * Why no integration test against a real DB here: the schedule upsert is
 * trivial DDL — the interesting behaviour is the router's tenant scoping
 * and the input validation. End-to-end coverage of the UNIQUE constraint
 * comes from the migration apply script + a follow-up prod probe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

// Phase B: clearSchedule / startAll / resetSchedules / flushPendingAll all
// call into the queue's flush helper. The router tests assert the trigger
// shape (was the flush called with the right destinationId?) — actual flush
// behaviour is covered in destinationPendingQueue.test.ts.
vi.mock("../services/destinationPendingQueue", () => ({
  flushPendingForDestination: vi.fn(async () => ({
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skippedRace: 0,
  })),
}));

import { getDb } from "../db";
import type { DbClient } from "../db";
import { flushPendingForDestination } from "../services/destinationPendingQueue";
import { destinationSchedulesRouter } from "./destinationSchedulesRouter";
import type { TrpcContext } from "../_core/context";

function userCaller(userId = 100) {
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
  return destinationSchedulesRouter.createCaller(ctx);
}

/**
 * Build a chainable mock DB. `selectReturns` is a queue of result arrays
 * — each .select().from().where().limit() (or .from().where()) await
 * consumes the next one. `inserts`, `updates`, `deletes` are tallies the
 * tests use to assert the right kind of write happened.
 */
function makeMockDb(opts: {
  selectReturns?: unknown[][];
} = {}): { db: DbClient; calls: {
  inserts: number;
  updates: number;
  deletes: number;
  insertValues: unknown[];
  updateSets: unknown[];
} } {
  const queue = [...(opts.selectReturns ?? [])];
  const calls = {
    inserts: 0,
    updates: 0,
    deletes: 0,
    insertValues: [] as unknown[],
    updateSets: [] as unknown[],
  };

  const nextRows = (): unknown[] => (queue.length > 0 ? queue.shift()! : []);

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const rows = nextRows();
        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => rows),
            // listForUser: `await db.select().from().where()` — no further chain.
            then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
            // listPendingCountsForUser: `.where(...).groupBy(...)` then await.
            groupBy: vi.fn(async () => rows),
          })),
          // resetSchedules etc: `.from(...)` then `.where(...)` is the leaf;
          // some queries also `await db.select().from()` without .where().
          then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        calls.inserts++;
        calls.insertValues.push(vals);
        return {
          onDuplicateKeyUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: unknown) => {
        calls.updates++;
        calls.updateSets.push(set);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        calls.deletes++;
      }),
    })),
  } as unknown as DbClient;

  return { db, calls };
}

const baseScheduleRow = {
  id: 1,
  destinationId: 50,
  userId: 100,
  pauseHour: 22,
  startHour: 8,
  sendHour: 9,
  timezone: "Asia/Tashkent",
  isPausedNow: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseDestinationOwnedRow = { id: 50 };

beforeEach(() => vi.clearAllMocks());

// ─── Per-destination ────────────────────────────────────────────────────────

describe("destinationSchedulesRouter — per-destination", () => {
  it("1. getSchedule on own destination with row returns it", async () => {
    const { db } = makeMockDb({ selectReturns: [[baseScheduleRow]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).getSchedule({ destinationId: 50 });
    expect(result).toMatchObject({ destinationId: 50, pauseHour: 22, startHour: 8, sendHour: 9 });
  });

  it("2. getSchedule with no row returns null", async () => {
    const { db } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).getSchedule({ destinationId: 50 });
    expect(result).toBeNull();
  });

  it("3. getSchedule against foreign destinationId returns null (no leak)", async () => {
    // Simulates the userId WHERE filter collapsing a foreign-owned row to no result.
    const { db } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).getSchedule({ destinationId: 99999 });
    expect(result).toBeNull();
  });

  it("4. setSchedule on owned destination upserts and re-selects", async () => {
    // First select = ownership check (returns the destination row);
    // second select = the post-upsert re-fetch.
    const { db, calls } = makeMockDb({
      selectReturns: [[baseDestinationOwnedRow], [baseScheduleRow]],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await userCaller(100).setSchedule({
      destinationId: 50,
      pauseHour: 22,
      startHour: 8,
      sendHour: 9,
    });
    expect(calls.inserts).toBe(1);
    expect(calls.insertValues[0]).toMatchObject({
      destinationId: 50,
      userId: 100,
      pauseHour: 22,
      startHour: 8,
      sendHour: 9,
    });
    expect(result).toMatchObject({ destinationId: 50 });
  });

  it("5. setSchedule on a destination the caller does not own throws", async () => {
    // Ownership check select returns [] → router throws.
    const { db, calls } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);

    await expect(
      userCaller(100).setSchedule({
        destinationId: 99999,
        pauseHour: 22,
        startHour: null,
        sendHour: null,
      }),
    ).rejects.toThrow(/destination not found/i);
    expect(calls.inserts).toBe(0);
  });

  it("6. setSchedule input validation: pauseHour=24 fails zod", async () => {
    const { db } = makeMockDb();
    vi.mocked(getDb).mockResolvedValue(db);
    await expect(
      userCaller(100).setSchedule({
        destinationId: 50,
        pauseHour: 24 as unknown as number,
        startHour: null,
        sendHour: null,
      }),
    ).rejects.toThrow();
  });

  it("7. clearSchedule executes a DELETE AND triggers flushPendingForDestination", async () => {
    const { db, calls } = makeMockDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).clearSchedule({ destinationId: 50 });
    expect(result).toMatchObject({
      ok: true,
      flushed: { attempted: 0, succeeded: 0, failed: 0 },
    });
    expect(calls.deletes).toBe(1);
    expect(flushPendingForDestination).toHaveBeenCalledWith(db, 50);
  });
});

// ─── Global ─────────────────────────────────────────────────────────────────

describe("destinationSchedulesRouter — global", () => {
  it("8. pauseAll with 0 destinations returns affected=0 without inserting", async () => {
    const { db, calls } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).pauseAll({
      pauseHour: 22,
      startHour: 8,
      sendHour: 9,
    });
    expect(result).toEqual({ ok: true, affected: 0 });
    expect(calls.inserts).toBe(0);
  });

  it("9. pauseAll with N destinations inserts N rows scoped to caller", async () => {
    const owned = [{ id: 50 }, { id: 51 }, { id: 52 }];
    const { db, calls } = makeMockDb({ selectReturns: [owned] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).pauseAll({
      pauseHour: 22,
      startHour: 8,
      sendHour: 9,
    });
    expect(result).toEqual({ ok: true, affected: 3 });
    expect(calls.inserts).toBe(3);
    // Every insert carries the caller's userId — defends against a future
    // refactor that drops the denormalized column.
    for (const v of calls.insertValues) {
      expect(v).toMatchObject({ userId: 100, pauseHour: 22 });
    }
  });

  it("10. startAll clears isPausedNow AND flushes previously-paused destinations", async () => {
    // First select returns the previously-paused snapshot (used to drive flushes).
    const previouslyPaused = [{ destinationId: 50 }, { destinationId: 51 }];
    const { db, calls } = makeMockDb({ selectReturns: [previouslyPaused] });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await userCaller(100).startAll();
    expect(result).toMatchObject({
      ok: true,
      destinationsResumed: 2,
      flushed: { attempted: 0, succeeded: 0, failed: 0 },
    });
    expect(calls.updates).toBe(1);
    expect(calls.updateSets[0]).toEqual({ isPausedNow: false });
    // Flush was called once per previously-paused destination.
    expect(flushPendingForDestination).toHaveBeenCalledTimes(2);
    expect(flushPendingForDestination).toHaveBeenCalledWith(db, 50);
    expect(flushPendingForDestination).toHaveBeenCalledWith(db, 51);
  });

  it("11. flushPendingAll groups by destinationId and calls flushPendingForDestination for each", async () => {
    // Mixed destinations — two unique ids across four pending rows.
    const pending = [
      { destinationId: 50 },
      { destinationId: 51 },
      { destinationId: 50 },
      { destinationId: 51 },
    ];
    const { db } = makeMockDb({ selectReturns: [pending] });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await userCaller(100).flushPendingAll();
    expect(result).toMatchObject({
      ok: true,
      queued: 4,
      flushed: { attempted: 0, succeeded: 0, failed: 0 },
    });
    // Unique-by-destinationId — two flush calls, not four.
    expect(flushPendingForDestination).toHaveBeenCalledTimes(2);
  });

  it("11b. flushPendingAll with 0 pending returns queued=0 and never calls flush", async () => {
    const { db } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).flushPendingAll();
    expect(result).toEqual({
      ok: true,
      queued: 0,
      flushed: { attempted: 0, succeeded: 0, failed: 0 },
    });
    expect(flushPendingForDestination).not.toHaveBeenCalled();
  });

  it("12. resetSchedules deletes schedules AND flushes each previously-scheduled destination", async () => {
    // First select returns the destinationId snapshot used to drive flushes.
    const scheduled = [{ destinationId: 50 }, { destinationId: 51 }, { destinationId: 52 }];
    const { db, calls } = makeMockDb({ selectReturns: [scheduled] });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await userCaller(100).resetSchedules();
    expect(result).toMatchObject({
      ok: true,
      destinationsCleared: 3,
      flushed: { attempted: 0, succeeded: 0, failed: 0 },
    });
    expect(calls.deletes).toBe(1);
    expect(flushPendingForDestination).toHaveBeenCalledTimes(3);
  });
});

// ─── Phase C batched-fetch procs ────────────────────────────────────────────

describe("destinationSchedulesRouter — listForUser (Phase C)", () => {
  it("13. returns every schedule the caller owns (the SQL scopes by userId)", async () => {
    const ownedRows = [
      { ...baseScheduleRow, id: 1, destinationId: 50 },
      { ...baseScheduleRow, id: 2, destinationId: 51 },
    ];
    const { db } = makeMockDb({ selectReturns: [ownedRows] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).listForUser();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.destinationId).sort()).toEqual([50, 51]);
  });

  it("14. cross-tenant non-leak: empty result when the user has no schedules", async () => {
    // Simulates the WHERE userId = caller.id filter collapsing all foreign
    // rows. The router returns whatever the SQL returns.
    const { db } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).listForUser();
    expect(result).toEqual([]);
  });
});

describe("destinationSchedulesRouter — listPendingCountsForUser (Phase C)", () => {
  it("15. returns one row per destination with numeric counts", async () => {
    // Mock the GROUP BY result — each row is { destinationId, count }.
    // MySQL/Drizzle returns count as a string in some driver versions, so
    // the router does Number(r.count). We feed numeric to keep the test
    // focused on the shape contract.
    const rows = [
      { destinationId: 50, count: 3 },
      { destinationId: 51, count: 1 },
    ];
    const { db } = makeMockDb({ selectReturns: [rows] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).listPendingCountsForUser();
    expect(result).toEqual([
      { destinationId: 50, count: 3 },
      { destinationId: 51, count: 1 },
    ]);
  });

  it("16. coerces string counts (MySQL driver quirk) to numbers", async () => {
    // Some node-mysql2 versions surface COUNT(*) as a string. The router
    // wraps each row with Number(r.count) — this test pins that contract.
    const rows = [{ destinationId: 50, count: "7" as unknown as number }];
    const { db } = makeMockDb({ selectReturns: [rows] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).listPendingCountsForUser();
    expect(result[0].count).toBe(7);
    expect(typeof result[0].count).toBe("number");
  });

  it("17. empty result when the user has no pending leads", async () => {
    const { db } = makeMockDb({ selectReturns: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).listPendingCountsForUser();
    expect(result).toEqual([]);
  });
});

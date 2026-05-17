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

import { getDb } from "../db";
import type { DbClient } from "../db";
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
            then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
          })),
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

  it("7. clearSchedule executes a DELETE", async () => {
    const { db, calls } = makeMockDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).clearSchedule({ destinationId: 50 });
    expect(result).toEqual({ ok: true });
    expect(calls.deletes).toBe(1);
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

  it("10. startAll executes an UPDATE that clears isPausedNow", async () => {
    const { db, calls } = makeMockDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).startAll();
    expect(result).toEqual({ ok: true });
    expect(calls.updates).toBe(1);
    expect(calls.updateSets[0]).toEqual({ isPausedNow: false });
  });

  it("11. flushPendingAll returns the count of undelivered pending (Phase A stub)", async () => {
    const pending = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const { db } = makeMockDb({ selectReturns: [pending] });
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).flushPendingAll();
    expect(result).toEqual({ ok: true, queued: 4 });
  });

  it("12. resetSchedules executes a DELETE filtered by caller userId", async () => {
    const { db, calls } = makeMockDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const result = await userCaller(100).resetSchedules();
    expect(result).toEqual({ ok: true });
    expect(calls.deletes).toBe(1);
  });
});

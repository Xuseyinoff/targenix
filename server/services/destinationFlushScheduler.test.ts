/**
 * Tests for destinationFlushScheduler.runFlushTick — Yuboraman parity
 * PR 4/4 Phase A.
 *
 * Coverage:
 *   13. Pause transition: schedule with pauseHour=currentHour & isPausedNow=false
 *       → UPDATE fires with { isPausedNow: true }
 *   14. Start transition: schedule with startHour=currentHour & isPausedNow=true
 *       → UPDATE fires with { isPausedNow: false }
 *   15. No transition: schedule with pauseHour matching current hour
 *       AND isPausedNow=true already → no UPDATE
 *   16. Send-hour stub: schedule with sendHour=currentHour →
 *       selects undelivered pending leads for that destination (Phase A
 *       log-only; we assert the count was queried)
 *   17. TTL stub: pending lead older than 24h → counted as stale
 *
 * timezone helper:
 *   18. currentHourInTimezone returns the expected hour for a known
 *       timezone + UTC instant
 *   19. currentHourInTimezone falls back to UTC for an invalid timezone
 *
 * Mock-DB style mirrors destinationSchedulesRouter.test.ts — a chainable
 * stub whose calls are recorded so the assertions can read what the
 * scheduler did without needing a real MySQL.
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
import {
  runFlushTick,
  stopDestinationFlushScheduler,
  currentHourInTimezone,
} from "./destinationFlushScheduler";

interface ScheduleRow {
  id: number;
  destinationId: number;
  userId: number;
  pauseHour: number | null;
  startHour: number | null;
  sendHour: number | null;
  timezone: string;
  isPausedNow: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function makeMockDb(opts: {
  schedules?: ScheduleRow[];
  undeliveredForDestinationId?: Record<number, unknown[]>;
  staleRows?: unknown[];
}): {
  db: DbClient;
  calls: {
    updates: number;
    updateSets: unknown[];
    selects: number;
  };
} {
  const schedules = opts.schedules ?? [];
  const undeliveredMap = opts.undeliveredForDestinationId ?? {};
  const staleRows = opts.staleRows ?? [];
  const calls = { updates: 0, updateSets: [] as unknown[], selects: 0 };

  // Track which select this is. The tick does:
  //   1. select schedules                              (#0)
  //   2..1+S. per-schedule (only if sendHour matches): select undelivered for destinationId
  //   last. select stale rows
  // We dispatch by counting and inspecting a per-call marker.
  let selectIndex = 0;
  const sendHourScheduleIds: number[] = []; // ids whose sendHour matches the current hour

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const index = selectIndex++;
        calls.selects++;
        if (index === 0) {
          // First select returns the schedules unconditionally — runFlushTick
          // pulls them all once at the top.
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => schedules),
              then: (r: (v: unknown) => unknown) => r(schedules),
            })),
            // .select() without .where(): used by `from(destinationSchedules)`
            then: (r: (v: unknown) => unknown) => r(schedules),
            limit: vi.fn(async () => schedules),
          };
        }
        // Subsequent selects: assume the last one is stale rows; everything
        // in between is the per-schedule undelivered lookup for the next
        // matching destination.
        const isLast = index === calls.selects - 1 + 0; // placeholder; recomputed below
        // We can't know "last" deterministically here; just return based on
        // remaining schedules with matching sendHour. The test driver
        // pre-computes the order by calling `setSendHourSchedules` first.
        if (sendHourScheduleIds.length > 0) {
          const destId = sendHourScheduleIds.shift()!;
          const rows = undeliveredMap[destId] ?? [];
          return {
            where: vi.fn(() => ({
              limit: vi.fn(async () => rows),
              then: (r: (v: unknown) => unknown) => r(rows),
            })),
            then: (r: (v: unknown) => unknown) => r(rows),
          };
        }
        // Stale query.
        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => staleRows),
            then: (r: (v: unknown) => unknown) => r(staleRows),
          })),
          then: (r: (v: unknown) => unknown) => r(staleRows),
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
    insert: vi.fn(),
    delete: vi.fn(),
  } as unknown as DbClient;

  // Helper exposed to tests so they can declare which schedules are
  // expected to hit the sendHour branch (in iteration order).
  (db as unknown as { __setSendHourSchedules: (ids: number[]) => void }).__setSendHourSchedules = (
    ids: number[],
  ) => {
    sendHourScheduleIds.length = 0;
    sendHourScheduleIds.push(...ids);
  };

  return { db, calls };
}

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 1,
    destinationId: 50,
    userId: 100,
    pauseHour: null,
    startHour: null,
    sendHour: null,
    timezone: "UTC",
    isPausedNow: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Resets the in-memory lastEvaluatedHour map between tests so each one
  // starts from a clean slate (otherwise a prior test that set hour=22
  // for schedule id=1 would suppress a later test trying to fire at the
  // same hour).
  stopDestinationFlushScheduler();
});

// ─── Transition tests ───────────────────────────────────────────────────────

describe("runFlushTick — pause/start transitions", () => {
  it("13. pauseHour=currentHour & !isPausedNow → UPDATE { isPausedNow: true }", async () => {
    // Use UTC and a fixed instant so the test hour is deterministic.
    const now = new Date(Date.UTC(2026, 0, 1, 22, 0, 0)); // 22:00 UTC
    const { db, calls } = makeMockDb({
      schedules: [scheduleRow({ pauseHour: 22, isPausedNow: false })],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(calls.updates).toBe(1);
    expect(calls.updateSets[0]).toEqual({ isPausedNow: true });
    expect(result.transitionsApplied).toBe(1);
  });

  it("14. startHour=currentHour & isPausedNow → UPDATE { isPausedNow: false }", async () => {
    const now = new Date(Date.UTC(2026, 0, 1, 8, 0, 0));
    const { db, calls } = makeMockDb({
      schedules: [scheduleRow({ startHour: 8, isPausedNow: true })],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(calls.updates).toBe(1);
    expect(calls.updateSets[0]).toEqual({ isPausedNow: false });
    expect(result.transitionsApplied).toBe(1);
  });

  it("15. pauseHour=currentHour but already paused → no UPDATE", async () => {
    const now = new Date(Date.UTC(2026, 0, 1, 22, 0, 0));
    const { db, calls } = makeMockDb({
      schedules: [scheduleRow({ pauseHour: 22, isPausedNow: true })],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(calls.updates).toBe(0);
    expect(result.transitionsApplied).toBe(0);
  });

  it("13b. second tick in the same hour does NOT re-fire the transition", async () => {
    const now = new Date(Date.UTC(2026, 0, 1, 22, 0, 0));
    const { db, calls } = makeMockDb({
      schedules: [scheduleRow({ pauseHour: 22, isPausedNow: false })],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    await runFlushTick(now);
    expect(calls.updates).toBe(1);

    // Second tick in the same hour: the in-memory lastEvaluatedHour map
    // suppresses the recompute. New mock DB so the schedule still looks
    // unpaused (real flow would have isPausedNow=true after the UPDATE).
    const { db: db2, calls: calls2 } = makeMockDb({
      schedules: [scheduleRow({ pauseHour: 22, isPausedNow: false })],
    });
    vi.mocked(getDb).mockResolvedValue(db2);
    await runFlushTick(now);
    expect(calls2.updates).toBe(0);
  });
});

// ─── Send-hour stub ─────────────────────────────────────────────────────────

describe("runFlushTick — sendHour flush stub (Phase A)", () => {
  it("16. sendHour=currentHour → selects undelivered count, logs intent, no UPDATE", async () => {
    const now = new Date(Date.UTC(2026, 0, 1, 9, 0, 0));
    const sched = scheduleRow({ id: 7, destinationId: 70, sendHour: 9 });
    const { db, calls } = makeMockDb({
      schedules: [sched],
      undeliveredForDestinationId: { 70: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    });
    (db as unknown as { __setSendHourSchedules: (ids: number[]) => void }).__setSendHourSchedules([
      70,
    ]);
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(calls.updates).toBe(0); // Phase A: no deliveredAt writes
    expect(result.flushStubs).toBe(1);
  });
});

// ─── TTL stub ───────────────────────────────────────────────────────────────

describe("runFlushTick — TTL stale-pending stub (Phase A)", () => {
  it("17. stale pending lead (>24h old) is counted and logged", async () => {
    const now = new Date(Date.UTC(2026, 0, 2, 12, 0, 0));
    const old = new Date(now.getTime() - 26 * 60 * 60 * 1000); // 26h old
    const { db } = makeMockDb({
      schedules: [],
      staleRows: [{ id: 999, destinationId: 70, userId: 100, createdAt: old }],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(result.staleStubs).toBe(1);
  });
});

// ─── Timezone helper ────────────────────────────────────────────────────────

describe("currentHourInTimezone", () => {
  it("18. converts a known UTC instant to the right local hour", () => {
    // 2026-01-01 00:00 UTC = 2026-01-01 05:00 Asia/Tashkent (UTC+5).
    const utc = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(currentHourInTimezone("Asia/Tashkent", utc)).toBe(5);
    expect(currentHourInTimezone("UTC", utc)).toBe(0);
  });

  it("19. falls back to UTC for an invalid timezone string", () => {
    const utc = new Date(Date.UTC(2026, 0, 1, 14, 0, 0));
    // "Not/A_Real_TZ" is rejected by Intl.DateTimeFormat — helper should
    // return the UTC hour and not throw.
    expect(currentHourInTimezone("Not/A_Real_TZ", utc)).toBe(14);
  });
});

/**
 * Tests for destinationFlushScheduler.runFlushTick — Yuboraman parity
 * PR 4/4. The scheduler now (Phase B) calls real flush helpers from
 * destinationPendingQueue; those are mocked here so the scheduler tests
 * stay focused on tick orchestration (transitions + when-to-call) and
 * queue behaviour is tested separately in destinationPendingQueue.test.ts.
 *
 * Coverage:
 *   13. Pause transition: schedule with pauseHour=currentHour & isPausedNow=false
 *       → UPDATE fires with { isPausedNow: true }
 *   14. Start transition: schedule with startHour=currentHour & isPausedNow=true
 *       → UPDATE fires with { isPausedNow: false } AND triggers a flush
 *       for that destination (Phase B — start means "deliver what was waiting")
 *   15. No transition: schedule with pauseHour matching current hour
 *       AND isPausedNow=true already → no UPDATE
 *   13b. Second tick in the same hour → no re-fire (in-memory dedupe map)
 *   16. Send-hour: schedule with sendHour=currentHour → calls
 *       flushPendingForDestination once for that destination id
 *   17. TTL: every tick calls flushStalePendingLeads (which counts/flushes
 *       anything older than 24h regardless of sendHour)
 *   17b. Every tick calls cleanupOrphanedPending so deleted-destination
 *       leads don't linger
 *
 * timezone helper:
 *   18. currentHourInTimezone returns the expected hour for a known
 *       timezone + UTC instant
 *   19. currentHourInTimezone falls back to UTC for an invalid timezone
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

vi.mock("./destinationPendingQueue", () => ({
  flushPendingForDestination: vi.fn(async () => ({
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skippedRace: 0,
  })),
  flushStalePendingLeads: vi.fn(async () => ({
    destinations: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
  })),
  cleanupOrphanedPending: vi.fn(async () => ({ cleaned: 0 })),
}));

import { getDb } from "../db";
import type { DbClient } from "../db";
import {
  flushPendingForDestination,
  flushStalePendingLeads,
  cleanupOrphanedPending,
} from "./destinationPendingQueue";
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

function makeMockDb(opts: { schedules?: ScheduleRow[] } = {}): {
  db: DbClient;
  calls: {
    updates: number;
    updateSets: unknown[];
  };
} {
  const schedules = opts.schedules ?? [];
  const calls = { updates: 0, updateSets: [] as unknown[] };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => schedules),
          then: (r: (v: unknown) => unknown) => r(schedules),
        })),
        then: (r: (v: unknown) => unknown) => r(schedules),
        limit: vi.fn(async () => schedules),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: unknown) => {
        calls.updates++;
        calls.updateSets.push(set);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    insert: vi.fn(),
    delete: vi.fn(),
  } as unknown as DbClient;

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
    const now = new Date(Date.UTC(2026, 0, 1, 22, 0, 0));
    const { db, calls } = makeMockDb({
      schedules: [scheduleRow({ pauseHour: 22, isPausedNow: false })],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(calls.updates).toBe(1);
    expect(calls.updateSets[0]).toEqual({ isPausedNow: true });
    expect(result.transitionsApplied).toBe(1);
  });

  it("14. startHour=currentHour & isPausedNow → UPDATE { isPausedNow: false } AND flush", async () => {
    const now = new Date(Date.UTC(2026, 0, 1, 8, 0, 0));
    const { db, calls } = makeMockDb({
      schedules: [scheduleRow({ destinationId: 70, startHour: 8, isPausedNow: true })],
    });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(calls.updates).toBe(1);
    expect(calls.updateSets[0]).toEqual({ isPausedNow: false });
    expect(result.transitionsApplied).toBe(1);
    // Start transition also triggers an immediate flush for that destination
    // — same semantics as a manual startAll.
    expect(flushPendingForDestination).toHaveBeenCalledWith(db, 70);
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

    const { db: db2, calls: calls2 } = makeMockDb({
      schedules: [scheduleRow({ pauseHour: 22, isPausedNow: false })],
    });
    vi.mocked(getDb).mockResolvedValue(db2);
    await runFlushTick(now);
    expect(calls2.updates).toBe(0);
  });
});

// ─── Send-hour flush ────────────────────────────────────────────────────────

describe("runFlushTick — sendHour flush (Phase B)", () => {
  it("16. sendHour=currentHour → calls flushPendingForDestination(destId)", async () => {
    const now = new Date(Date.UTC(2026, 0, 1, 9, 0, 0));
    const sched = scheduleRow({ id: 7, destinationId: 70, sendHour: 9 });
    const { db } = makeMockDb({ schedules: [sched] });
    vi.mocked(getDb).mockResolvedValue(db);

    const result = await runFlushTick(now);
    expect(flushPendingForDestination).toHaveBeenCalledWith(db, 70);
    expect(result.sendHoursTriggered).toBe(1);
  });
});

// ─── TTL + orphan ───────────────────────────────────────────────────────────

describe("runFlushTick — TTL + orphan cleanup (Phase B)", () => {
  it("17. every tick calls flushStalePendingLeads", async () => {
    const now = new Date(Date.UTC(2026, 0, 2, 12, 0, 0));
    const { db } = makeMockDb({ schedules: [] });
    vi.mocked(getDb).mockResolvedValue(db);

    await runFlushTick(now);
    expect(flushStalePendingLeads).toHaveBeenCalledWith(db, now);
  });

  it("17b. every tick calls cleanupOrphanedPending", async () => {
    const now = new Date(Date.UTC(2026, 0, 2, 12, 0, 0));
    const { db } = makeMockDb({ schedules: [] });
    vi.mocked(getDb).mockResolvedValue(db);

    await runFlushTick(now);
    expect(cleanupOrphanedPending).toHaveBeenCalledWith(db);
  });
});

// ─── Timezone helper ────────────────────────────────────────────────────────

describe("currentHourInTimezone", () => {
  it("18. converts a known UTC instant to the right local hour", () => {
    const utc = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(currentHourInTimezone("Asia/Tashkent", utc)).toBe(5);
    expect(currentHourInTimezone("UTC", utc)).toBe(0);
  });

  it("19. falls back to UTC for an invalid timezone string", () => {
    const utc = new Date(Date.UTC(2026, 0, 1, 14, 0, 0));
    expect(currentHourInTimezone("Not/A_Real_TZ", utc)).toBe(14);
  });
});

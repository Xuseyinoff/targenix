/**
 * Tests for destinationPendingQueue — Yuboraman parity PR 4/4 Phase B.
 *
 * Coverage:
 *   Feature flag + pause check (drives the dispatch routing):
 *    20. schedulesFeatureFlagOn returns true only when the env var is "true"
 *    21. shouldQueueForPause: flag off → returns null (no DB query made)
 *    22. shouldQueueForPause: flag on + no schedule → returns null
 *    23. shouldQueueForPause: flag on + isPausedNow=false → returns null
 *    24. shouldQueueForPause: flag on + isPausedNow=true → returns schedule
 *
 *   computeNextSendTime:
 *    25. sendHour=null → null (lead waits indefinitely, TTL kicks in)
 *    26. sendHour today in the future (UTC) → returns today's instant
 *    27. sendHour today already past → returns tomorrow
 *    28. Timezone respected (Asia/Tashkent, UTC+5)
 *    29. Midnight edge — sendHour=0 returns next 00:00 in the schedule's tz
 *
 *   enqueuePendingLead:
 *    30. Inserts a row with the right (destinationId, leadId, userId, payload)
 *        and computes scheduledFor from the schedule
 *
 *   flushPendingForDestination:
 *    31. No pending → no-op, attempted=0
 *    32. Destination missing → no-op (the orphan-cleanup path will handle it)
 *    33. Successful dispatch → atomic claim wins, deliveredAt is set,
 *        succeeded++; dispatchDelivery called with the stored leadPayload
 *    34. Dispatch fails → claim is rolled back, deliveryError is recorded,
 *        retryCount incremented, failed++
 *    35. Concurrent tick already claimed the row (affectedRows=0) → skipped,
 *        skippedRace++, dispatchDelivery NOT called
 *
 *   flushStalePendingLeads:
 *    36. Returns 0 destinations when no stale rows
 *    37. Groups by destinationId and calls flushPendingForDestination once
 *        per unique destination
 *
 *   cleanupOrphanedPending:
 *    38. No orphans → 0
 *    39. Orphans present → marks each with deliveryError="destination_deleted"
 *
 * Why mock `dispatchDelivery` instead of running the real adapter chain:
 * the queue's job is "call dispatchDelivery, persist the outcome." The
 * adapter behaviour is covered by integrations/dispatch tests already.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../integrations/dispatch", () => ({
  dispatchDelivery: vi.fn(),
}));

import type { DbClient } from "../db";
import { dispatchDelivery } from "../integrations/dispatch";
import {
  schedulesFeatureFlagOn,
  shouldQueueForPause,
  computeNextSendTime,
  enqueuePendingLead,
  flushPendingForDestination,
  flushStalePendingLeads,
  cleanupOrphanedPending,
} from "./destinationPendingQueue";
import type { DestinationSchedule } from "../../drizzle/schema";

const ORIGINAL_FLAG = process.env.DESTINATION_SCHEDULES_ENABLED;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.DESTINATION_SCHEDULES_ENABLED;
  else process.env.DESTINATION_SCHEDULES_ENABLED = ORIGINAL_FLAG;
  vi.clearAllMocks();
});

function scheduleRow(overrides: Partial<DestinationSchedule> = {}): DestinationSchedule {
  return {
    id: 1,
    destinationId: 50,
    userId: 100,
    pauseHour: 22,
    startHour: 8,
    sendHour: 9,
    timezone: "UTC",
    isPausedNow: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Feature flag + pause check ─────────────────────────────────────────────

describe("schedulesFeatureFlagOn", () => {
  it("20a. true when env var is 'true'", () => {
    process.env.DESTINATION_SCHEDULES_ENABLED = "true";
    expect(schedulesFeatureFlagOn()).toBe(true);
  });

  it("20b. false when env var is unset or 'false' (case-sensitive)", () => {
    delete process.env.DESTINATION_SCHEDULES_ENABLED;
    expect(schedulesFeatureFlagOn()).toBe(false);
    process.env.DESTINATION_SCHEDULES_ENABLED = "false";
    expect(schedulesFeatureFlagOn()).toBe(false);
    process.env.DESTINATION_SCHEDULES_ENABLED = "TRUE"; // strict match: must be lowercase
    expect(schedulesFeatureFlagOn()).toBe(false);
  });
});

describe("shouldQueueForPause", () => {
  function dbWithSchedule(row: DestinationSchedule | null): DbClient {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => (row ? [row] : [])),
          })),
        })),
      })),
    } as unknown as DbClient;
  }

  it("21. flag off → returns null without querying", async () => {
    delete process.env.DESTINATION_SCHEDULES_ENABLED;
    const db = dbWithSchedule(scheduleRow({ isPausedNow: true }));
    const result = await shouldQueueForPause(db, 50);
    expect(result).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("22. flag on + no schedule row → null", async () => {
    process.env.DESTINATION_SCHEDULES_ENABLED = "true";
    const db = dbWithSchedule(null);
    expect(await shouldQueueForPause(db, 50)).toBeNull();
  });

  it("23. flag on + isPausedNow=false → null", async () => {
    process.env.DESTINATION_SCHEDULES_ENABLED = "true";
    const db = dbWithSchedule(scheduleRow({ isPausedNow: false }));
    expect(await shouldQueueForPause(db, 50)).toBeNull();
  });

  it("24. flag on + isPausedNow=true → returns the schedule row", async () => {
    process.env.DESTINATION_SCHEDULES_ENABLED = "true";
    const sched = scheduleRow({ isPausedNow: true, sendHour: 9 });
    const db = dbWithSchedule(sched);
    const result = await shouldQueueForPause(db, 50);
    expect(result).toEqual(sched);
  });
});

// ─── computeNextSendTime ────────────────────────────────────────────────────

describe("computeNextSendTime", () => {
  it("25. sendHour=null → null", () => {
    expect(
      computeNextSendTime(
        { sendHour: null, timezone: "UTC" },
        new Date(Date.UTC(2026, 0, 1, 12, 0)),
      ),
    ).toBeNull();
  });

  it("26. sendHour later today (UTC) → today's instant top of hour", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 8, 30));
    const next = computeNextSendTime({ sendHour: 14, timezone: "UTC" }, now);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("27. sendHour earlier today → tomorrow's instant", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 18, 30));
    const next = computeNextSendTime({ sendHour: 9, timezone: "UTC" }, now);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-01-02T09:00:00.000Z");
  });

  it("28. Asia/Tashkent (UTC+5): sendHour=9 with now=12:00 UTC → 04:00 UTC tomorrow", () => {
    // 12:00 UTC = 17:00 Tashkent (past 09:00 today) → next 09:00 Tashkent
    // = 04:00 UTC of the next day.
    const now = new Date(Date.UTC(2026, 0, 1, 12, 0));
    const next = computeNextSendTime({ sendHour: 9, timezone: "Asia/Tashkent" }, now);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-01-02T04:00:00.000Z");
  });

  it("29. midnight (sendHour=0) returns next 00:00 in the tz", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 12, 0));
    const next = computeNextSendTime({ sendHour: 0, timezone: "UTC" }, now);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});

// ─── enqueuePendingLead ─────────────────────────────────────────────────────

describe("enqueuePendingLead", () => {
  it("30. inserts a row with the correct payload and scheduledFor", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          inserted = v;
          return Promise.resolve();
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => [{ id: 777 }]),
            })),
          })),
        })),
      })),
    } as unknown as DbClient;

    const sched = scheduleRow({ sendHour: 9, timezone: "UTC" });
    const result = await enqueuePendingLead({
      db,
      destinationId: 50,
      leadId: 1234,
      userId: 100,
      payload: {
        leadPayload: {
          leadgenId: "lg-1",
          fullName: "X",
          phone: "+1",
          email: null,
          pageId: "p1",
          formId: "f1",
        },
        integrationId: 99,
        integrationConfig: { variableFields: { offer_id: "1" } },
        variableFields: { offer_id: "1" },
      },
      schedule: sched,
    });

    expect(result.id).toBe(777);
    expect(result.scheduledFor).not.toBeNull();
    expect(inserted).not.toBeNull();
    expect(inserted!).toMatchObject({
      destinationId: 50,
      leadId: 1234,
      userId: 100,
    });
    const storedPayload = (inserted as { payload: { integrationId: number } }).payload;
    expect(storedPayload.integrationId).toBe(99);
  });
});

// ─── flushPendingForDestination ─────────────────────────────────────────────

describe("flushPendingForDestination", () => {
  /**
   * Build a DB mock specifically shaped for the flush function's call order:
   *   1. select pending rows for destinationId  (returns `pending`)
   *   2. select destination row by id           (returns `destination` or [])
   *   3. for each pending row:
   *      a. update SET deliveredAt=NOW() WHERE id=? AND deliveredAt IS NULL
   *         → result.affectedRows from `claimResults`
   *      b. on success: log only
   *      c. on dispatch failure: update SET deliveredAt=NULL, deliveryError, retryCount++
   *   4. log info "batch complete"
   */
  function makeFlushDb(opts: {
    pending: Array<{ id: number; destinationId: number; leadId: number; userId: number; payload: unknown; retryCount: number; createdAt: Date }>;
    destination: { id: number; userId: number; name: string; appKey: string } | null;
    claimResults?: number[];
  }) {
    const pending = opts.pending;
    const destination = opts.destination;
    const claims = [...(opts.claimResults ?? Array.from({ length: pending.length }, () => 1))];
    let selectCount = 0;
    const updates: Array<{ set: Record<string, unknown> }> = [];

    const db = {
      select: vi.fn(() => {
        const i = selectCount++;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (i === 0) {
                // pending rows
                return {
                  orderBy: vi.fn(async () => pending),
                };
              }
              // destination lookup
              return {
                limit: vi.fn(async () => (destination ? [destination] : [])),
              };
            }),
          })),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn((set: Record<string, unknown>) => {
          updates.push({ set });
          // First update per row = atomic claim. The order matches the
          // for-loop in flushPendingForDestination.
          const idx = updates.length - 1;
          // Each pending row consumes one claim. After the claim, a failure
          // pushes a second update for the rollback. We only care about
          // claim semantics here — non-claim updates resolve normally.
          const claimAffected = idx < claims.length ? claims[idx] : 1;
          return {
            where: vi.fn(async () => ({ affectedRows: claimAffected })),
          };
        }),
      })),
      insert: vi.fn(),
      delete: vi.fn(),
    } as unknown as DbClient;

    return { db, updates };
  }

  const baseDestination = {
    id: 50,
    userId: 100,
    name: "dest",
    appKey: "100k",
  } as never;

  const basePending = {
    id: 1,
    destinationId: 50,
    leadId: 1234,
    userId: 100,
    payload: {
      leadPayload: {
        leadgenId: "lg-1",
        fullName: "X",
        phone: "+1",
        email: null,
        pageId: "p1",
        formId: "f1",
      },
      integrationId: 99,
      integrationConfig: {},
      variableFields: {},
    },
    retryCount: 0,
    createdAt: new Date(),
  };

  it("31. no pending → attempted=0, no DB writes", async () => {
    const { db, updates } = makeFlushDb({ pending: [], destination: baseDestination });
    const result = await flushPendingForDestination(db, 50);
    expect(result.attempted).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("32. destination missing → no-op", async () => {
    const { db } = makeFlushDb({
      pending: [basePending],
      destination: null,
    });
    const result = await flushPendingForDestination(db, 50);
    expect(result.attempted).toBe(0);
    expect(dispatchDelivery).not.toHaveBeenCalled();
  });

  it("33. successful dispatch → claim wins, dispatchDelivery called, succeeded++", async () => {
    vi.mocked(dispatchDelivery).mockResolvedValueOnce({
      success: true,
      adapterKey: "100k",
    });
    const { db, updates } = makeFlushDb({
      pending: [basePending],
      destination: baseDestination,
      claimResults: [1],
    });
    const result = await flushPendingForDestination(db, 50);
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(dispatchDelivery).toHaveBeenCalledTimes(1);
    // Only the atomic claim update fires on success — no rollback.
    expect(updates.length).toBe(1);
    expect(updates[0].set).toMatchObject({ deliveredAt: expect.any(Date) });
  });

  it("34. dispatch fails → rollback claim, deliveryError stored, retryCount++", async () => {
    vi.mocked(dispatchDelivery).mockResolvedValueOnce({
      success: false,
      error: "partner_5xx",
      adapterKey: "100k",
    });
    const { db, updates } = makeFlushDb({
      pending: [basePending],
      destination: baseDestination,
      claimResults: [1],
    });
    const result = await flushPendingForDestination(db, 50);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    // Two updates: the claim, then the rollback that sets deliveryError.
    expect(updates.length).toBe(2);
    expect(updates[1].set).toMatchObject({
      deliveredAt: null,
      deliveryError: "partner_5xx",
    });
    expect(updates[1].set.retryCount).toBeDefined();
  });

  it("35. concurrent tick already claimed (affectedRows=0) → skippedRace, no dispatch", async () => {
    const { db } = makeFlushDb({
      pending: [basePending],
      destination: baseDestination,
      claimResults: [0],
    });
    const result = await flushPendingForDestination(db, 50);
    expect(result.skippedRace).toBe(1);
    expect(result.attempted).toBe(0);
    expect(dispatchDelivery).not.toHaveBeenCalled();
  });
});

// ─── flushStalePendingLeads ─────────────────────────────────────────────────

describe("flushStalePendingLeads", () => {
  it("36. no stale rows → destinations=0", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
      })),
    } as unknown as DbClient;
    const result = await flushStalePendingLeads(db, new Date());
    expect(result.destinations).toBe(0);
  });

  it("37. groups by destinationId — N unique destinations → N flushes (recursive call shape)", async () => {
    // The function fans out to flushPendingForDestination per unique destId.
    // We just need the initial stale SELECT to return rows with distinct
    // destinationIds; the inner flushes will hit the same mock and return
    // empty pending each time (no follow-on dispatch).
    let selectCount = 0;
    const db = {
      select: vi.fn(() => {
        const i = selectCount++;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (i === 0) {
                // stale rows
                return Promise.resolve([
                  { destinationId: 50 },
                  { destinationId: 51 },
                  { destinationId: 50 }, // duplicate, deduped to {50, 51}
                ]);
              }
              // per-destination flush: pending SELECT returns empty so
              // the inner flushPendingForDestination short-circuits.
              return { orderBy: vi.fn(async () => []), limit: vi.fn(async () => []) };
            }),
          })),
        };
      }),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    } as unknown as DbClient;

    const result = await flushStalePendingLeads(db, new Date());
    expect(result.destinations).toBe(2);
  });
});

// ─── cleanupOrphanedPending ─────────────────────────────────────────────────

describe("cleanupOrphanedPending", () => {
  it("38. no orphans → cleaned=0", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async () => []),
          })),
        })),
      })),
      update: vi.fn(),
    } as unknown as DbClient;
    const result = await cleanupOrphanedPending(db);
    expect(result.cleaned).toBe(0);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("39. orphans present → marks each with deliveryError='destination_deleted'", async () => {
    let updateSet: Record<string, unknown> | null = null;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async () => [{ id: 100 }, { id: 101 }, { id: 102 }]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((s: Record<string, unknown>) => {
          updateSet = s;
          return { where: vi.fn(async () => undefined) };
        }),
      })),
    } as unknown as DbClient;
    const result = await cleanupOrphanedPending(db);
    expect(result.cleaned).toBe(3);
    expect(updateSet).toMatchObject({
      deliveryError: "destination_deleted",
    });
  });
});

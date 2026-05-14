/**
 * metricSnapshotScheduler — capture semantics:
 *   - counter rows reflect the read-and-reset delta (so each row is the
 *     activity in the interval, not a cumulative-since-boot value that
 *     drops to 0 on restart)
 *   - gauge rows reflect the current point-in-time DB reading
 *   - DB read failures don't block the snapshot; counters still persist
 *   - DB insert failures don't throw; the delta is logged as a fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../monitoring/metrics", () => ({
  readAndResetCounters: vi.fn(),
  getFailedOrdersCountDb: vi.fn(),
  getRetryQueueSize: vi.fn(),
}));

import { captureMetricSnapshot } from "./metricSnapshotScheduler";
import {
  readAndResetCounters,
  getFailedOrdersCountDb,
  getRetryQueueSize,
} from "../monitoring/metrics";
import type { DbClient } from "../db";

function makeRecordingDb(): { db: DbClient; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((rows: unknown[]) => {
        inserts.push(rows);
        return Promise.resolve();
      }),
    })),
  } as unknown as DbClient;
  return { db, inserts };
}

describe("captureMetricSnapshot — happy path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts one row per metric with the expected (metric, kind, value) tuples", async () => {
    vi.mocked(readAndResetCounters).mockReturnValue({ failedOrders: 17, oauthErrors: 3 });
    vi.mocked(getFailedOrdersCountDb).mockResolvedValue(42);
    vi.mocked(getRetryQueueSize).mockResolvedValue(8);

    const { db, inserts } = makeRecordingDb();
    await captureMetricSnapshot(db);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual([
      { metric: "failed_orders",    kind: "counter", value: 17 },
      { metric: "oauth_errors",     kind: "counter", value: 3 },
      { metric: "failed_orders_db", kind: "gauge",   value: 42 },
      { metric: "retry_queue_size", kind: "gauge",   value: 8 },
    ]);
  });

  it("calls readAndResetCounters exactly once per snapshot (resets the in-memory state)", async () => {
    vi.mocked(readAndResetCounters).mockReturnValue({ failedOrders: 0, oauthErrors: 0 });
    vi.mocked(getFailedOrdersCountDb).mockResolvedValue(0);
    vi.mocked(getRetryQueueSize).mockResolvedValue(0);
    const { db } = makeRecordingDb();

    await captureMetricSnapshot(db);
    await captureMetricSnapshot(db);

    expect(vi.mocked(readAndResetCounters)).toHaveBeenCalledTimes(2);
  });

  it("records all-zero rows when the counters drained empty", async () => {
    vi.mocked(readAndResetCounters).mockReturnValue({ failedOrders: 0, oauthErrors: 0 });
    vi.mocked(getFailedOrdersCountDb).mockResolvedValue(0);
    vi.mocked(getRetryQueueSize).mockResolvedValue(0);

    const { db, inserts } = makeRecordingDb();
    await captureMetricSnapshot(db);

    const row = inserts[0] as Array<{ value: number }>;
    expect(row.every((r) => r.value === 0)).toBe(true);
  });
});

describe("captureMetricSnapshot — failure paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to gauge=0 when the DB gauge read throws (counters still recorded)", async () => {
    vi.mocked(readAndResetCounters).mockReturnValue({ failedOrders: 5, oauthErrors: 2 });
    vi.mocked(getFailedOrdersCountDb).mockRejectedValue(new Error("conn lost"));
    vi.mocked(getRetryQueueSize).mockResolvedValue(0); // would never run after Promise.all rejects

    const { db, inserts } = makeRecordingDb();
    await captureMetricSnapshot(db);

    expect(inserts).toHaveLength(1);
    const rows = inserts[0] as Array<{ metric: string; value: number }>;
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
    // Counters preserved (the in-memory delta has already been consumed —
    // we MUST persist it or it's lost forever).
    expect(byMetric.failed_orders).toBe(5);
    expect(byMetric.oauth_errors).toBe(2);
    // Gauges fall back to 0 — better than dropping the whole snapshot.
    expect(byMetric.failed_orders_db).toBe(0);
    expect(byMetric.retry_queue_size).toBe(0);
  });

  it("does not throw when the DB insert itself rejects", async () => {
    vi.mocked(readAndResetCounters).mockReturnValue({ failedOrders: 1, oauthErrors: 0 });
    vi.mocked(getFailedOrdersCountDb).mockResolvedValue(0);
    vi.mocked(getRetryQueueSize).mockResolvedValue(0);

    const explodingDb = {
      insert: vi.fn(() => ({
        values: vi.fn(() => Promise.reject(new Error("deadlock"))),
      })),
    } as unknown as DbClient;

    await expect(captureMetricSnapshot(explodingDb)).resolves.toBeUndefined();
  });
});


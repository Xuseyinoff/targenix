/**
 * Unit tests for the dual-write layer introduced in Commit 4 of Phase 4.
 *
 * The helpers are thin wrappers around Drizzle, so we verify:
 *   - The right SQL shape runs (delete-then-insert inside one transaction).
 *   - `position` mirrors input array order.
 *   - Duplicate target ids collapse into one row.
 *   - Invalid ids are rejected / filtered.
 *   - Passing an empty list clears the set without re-inserting.
 *   - listIntegrationDestinations sorts by position then id in memory.
 *
 * We stub the DbClient to capture the chain of calls. Drizzle itself is
 * well-tested upstream; we only need to assert the call graph our helpers
 * construct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listIntegrationDestinations,
  setIntegrationDestinations,
  syncLegacyDestination,
} from "./integrationDestinations";
import type { DbClient } from "../db";

// ─── test doubles ──────────────────────────────────────────────────────────

/** Capture every insert .values() payload for later assertions. */
interface TxSpy {
  deletes: Array<unknown>;
  inserts: Array<Array<Record<string, unknown>>>;
}

function makeTx(spy: TxSpy) {
  const deleteChain = {
    where: vi.fn().mockImplementation((w: unknown) => {
      spy.deletes.push(w);
      return Promise.resolve();
    }),
  };
  const insertChain = {
    values: vi.fn().mockImplementation((rows: Array<Record<string, unknown>>) => {
      spy.inserts.push(rows);
      return Promise.resolve();
    }),
  };
  return {
    delete: vi.fn().mockReturnValue(deleteChain),
    insert: vi.fn().mockReturnValue(insertChain),
  };
}

function makeDbWithTx(spy: TxSpy): DbClient {
  return {
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(makeTx(spy));
    }),
  } as unknown as DbClient;
}

function makeDbWithSelect(rows: unknown[]): DbClient {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(Promise.resolve(rows)),
  };
  return {
    select: vi.fn(() => chain),
  } as unknown as DbClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── setIntegrationDestinations ────────────────────────────────────────────

describe("setIntegrationDestinations", () => {
  it("wipes then inserts inside one transaction, preserving input order as position", async () => {
    const spy: TxSpy = { deletes: [], inserts: [] };
    const db = makeDbWithTx(spy);

    await setIntegrationDestinations(db, 7, [101, 102, 103]);

    expect(spy.deletes).toHaveLength(1);
    expect(spy.inserts).toHaveLength(1);
    expect(spy.inserts[0]).toEqual([
      { integrationId: 7, targetWebsiteId: 101, position: 0, enabled: true },
      { integrationId: 7, targetWebsiteId: 102, position: 1, enabled: true },
      { integrationId: 7, targetWebsiteId: 103, position: 2, enabled: true },
    ]);
  });

  it("dedupes repeated target ids, keeping the first occurrence's position", async () => {
    const spy: TxSpy = { deletes: [], inserts: [] };
    const db = makeDbWithTx(spy);

    await setIntegrationDestinations(db, 1, [50, 51, 50, 52]);

    expect(spy.inserts[0]).toEqual([
      { integrationId: 1, targetWebsiteId: 50, position: 0, enabled: true },
      { integrationId: 1, targetWebsiteId: 51, position: 1, enabled: true },
      { integrationId: 1, targetWebsiteId: 52, position: 2, enabled: true },
    ]);
  });

  it("filters out non-positive / non-finite ids defensively", async () => {
    const spy: TxSpy = { deletes: [], inserts: [] };
    const db = makeDbWithTx(spy);

    await setIntegrationDestinations(db, 1, [0, -5, Number.NaN, 99]);

    expect(spy.inserts[0]).toEqual([
      { integrationId: 1, targetWebsiteId: 99, position: 0, enabled: true },
    ]);
  });

  it("clears the set when called with an empty array (no insert issued)", async () => {
    const spy: TxSpy = { deletes: [], inserts: [] };
    const db = makeDbWithTx(spy);

    await setIntegrationDestinations(db, 1, []);

    expect(spy.deletes).toHaveLength(1);
    expect(spy.inserts).toHaveLength(0);
  });

  it("rejects invalid integration ids with a clear error", async () => {
    const db = makeDbWithTx({ deletes: [], inserts: [] });

    await expect(setIntegrationDestinations(db, 0, [1])).rejects.toThrow(
      /invalid integrationId/i,
    );
    await expect(setIntegrationDestinations(db, -3, [1])).rejects.toThrow(
      /invalid integrationId/i,
    );
    await expect(setIntegrationDestinations(db, NaN, [1])).rejects.toThrow(
      /invalid integrationId/i,
    );
  });
});

// ─── syncLegacyDestination ─────────────────────────────────────────────────

describe("syncLegacyDestination", () => {
  it("converts a single id into a one-row set", async () => {
    const spy: TxSpy = { deletes: [], inserts: [] };
    const db = makeDbWithTx(spy);

    await syncLegacyDestination(db, 9, 42);

    expect(spy.inserts[0]).toEqual([
      { integrationId: 9, targetWebsiteId: 42, position: 0, enabled: true },
    ]);
  });

  it("clears the set when called with null", async () => {
    const spy: TxSpy = { deletes: [], inserts: [] };
    const db = makeDbWithTx(spy);

    await syncLegacyDestination(db, 9, null);

    expect(spy.deletes).toHaveLength(1);
    expect(spy.inserts).toHaveLength(0);
  });
});

// ─── listIntegrationDestinations ───────────────────────────────────────────

describe("listIntegrationDestinations", () => {
  it("returns rows sorted by position, then id for stability", async () => {
    const unsorted = [
      { id: 3, integrationId: 1, targetWebsiteId: 10, position: 2, enabled: true },
      { id: 1, integrationId: 1, targetWebsiteId: 20, position: 0, enabled: true },
      { id: 2, integrationId: 1, targetWebsiteId: 30, position: 1, enabled: true },
      { id: 5, integrationId: 1, targetWebsiteId: 40, position: 0, enabled: true },
    ];
    const db = makeDbWithSelect(unsorted);

    const rows = await listIntegrationDestinations(db, 1);

    expect(rows.map((r) => r.id)).toEqual([1, 5, 2, 3]);
  });

  it("forwards onlyEnabled as a WHERE filter without crashing", async () => {
    const db = makeDbWithSelect([]);
    const rows = await listIntegrationDestinations(db, 1, { onlyEnabled: true });
    expect(rows).toEqual([]);
  });
});

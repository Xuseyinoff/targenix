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

import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  listIntegrationDestinations,
  resolveIntegrationDestinations,
  setIntegrationDestinations,
  syncLegacyDestination,
} from "./integrationDestinations";
import { __resetFeatureFlagsCache } from "./featureFlags";
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

// ─── resolveIntegrationDestinations ────────────────────────────────────────
//
// These tests exercise the dual-read wiring introduced in Commit 5a:
//   - flag OFF → legacy column path (single SELECT on target_websites)
//   - flag ON  → new table path (JOIN against integration_destinations)
// We stub the DB chain loosely; the point is to verify the decision tree
// and ownership filtering, not drizzle's SQL generation.

interface LegacyDbState {
  targetWebsiteRow: Record<string, unknown> | null;
}

interface NewDbState {
  joinRows: Array<{
    mapping: { id: number; position: number; enabled: boolean };
    tw: Record<string, unknown>;
  }>;
}

function makeLegacyDb(state: LegacyDbState): DbClient {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(state.targetWebsiteRow ? [state.targetWebsiteRow] : []),
  };
  return { select: vi.fn(() => chain) } as unknown as DbClient;
}

function makeNewTableDb(state: NewDbState): DbClient {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(state.joinRows),
  };
  return { select: vi.fn(() => chain) } as unknown as DbClient;
}

describe("resolveIntegrationDestinations — legacy column path", () => {
  beforeEach(() => {
    delete process.env.MULTI_DEST_ALL;
    delete process.env.MULTI_DEST_USER_IDS;
    __resetFeatureFlagsCache();
  });

  it("returns the single row for a happy-path integration", async () => {
    const tw = { id: 200, userId: 1, name: "Sotuvchi" };
    const db = makeLegacyDb({ targetWebsiteRow: tw });
    const out = await resolveIntegrationDestinations(db, {
      id: 1,
      userId: 1,
      targetWebsiteId: 200,
      config: {},
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      mappingId: null,
      position: 0,
      enabled: true,
      targetWebsite: tw,
    });
  });

  it("falls back to config.targetWebsiteId when the column is null", async () => {
    const tw = { id: 99, userId: 7 };
    const db = makeLegacyDb({ targetWebsiteRow: tw });
    const out = await resolveIntegrationDestinations(db, {
      id: 2,
      userId: 7,
      targetWebsiteId: null,
      config: { targetWebsiteId: 99 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].targetWebsite).toBe(tw);
  });

  it("returns an empty list when no target is configured anywhere", async () => {
    const db = makeLegacyDb({ targetWebsiteRow: null });
    const out = await resolveIntegrationDestinations(db, {
      id: 3,
      userId: 1,
      targetWebsiteId: null,
      config: {},
    });
    expect(out).toEqual([]);
  });

  it("filters owner-mismatched target_websites out of the result", async () => {
    const db = makeLegacyDb({
      targetWebsiteRow: { id: 10, userId: 99 },
    });
    const out = await resolveIntegrationDestinations(db, {
      id: 4,
      userId: 1,
      targetWebsiteId: 10,
      config: {},
    });
    expect(out).toEqual([]);
  });
});

describe("resolveIntegrationDestinations — new table path", () => {
  beforeEach(() => {
    process.env.MULTI_DEST_USER_IDS = "42";
    __resetFeatureFlagsCache();
  });

  afterEach(() => {
    delete process.env.MULTI_DEST_USER_IDS;
    __resetFeatureFlagsCache();
  });

  it("returns rows from integration_destinations when flag is on, ordered by position", async () => {
    const db = makeNewTableDb({
      joinRows: [
        {
          mapping: { id: 3, position: 1, enabled: true },
          tw: { id: 302, userId: 42, name: "Sheets" },
        },
        {
          mapping: { id: 7, position: 0, enabled: true },
          tw: { id: 301, userId: 42, name: "Telegram" },
        },
      ],
    });
    const out = await resolveIntegrationDestinations(db, {
      id: 10,
      userId: 42,
      targetWebsiteId: null,
      config: {},
    });
    expect(out.map((r) => r.mappingId)).toEqual([7, 3]);
    expect(out[0].targetWebsite).toMatchObject({ id: 301 });
  });

  it("drops rows whose target_website owner differs from the integration", async () => {
    const db = makeNewTableDb({
      joinRows: [
        {
          mapping: { id: 1, position: 0, enabled: true },
          tw: { id: 999, userId: 5 /* mismatch */ },
        },
        {
          mapping: { id: 2, position: 1, enabled: true },
          tw: { id: 1000, userId: 42 },
        },
      ],
    });
    const out = await resolveIntegrationDestinations(db, {
      id: 10,
      userId: 42,
      targetWebsiteId: null,
      config: {},
    });
    expect(out).toHaveLength(1);
    expect(out[0].mappingId).toBe(2);
  });

  it("returns [] when the integration has no destination rows on the flagged path", async () => {
    const db = makeNewTableDb({ joinRows: [] });
    const out = await resolveIntegrationDestinations(db, {
      id: 10,
      userId: 42,
      targetWebsiteId: null,
      config: {},
    });
    expect(out).toEqual([]);
  });
});

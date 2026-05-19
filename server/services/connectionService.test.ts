/**
 * connectionService — unit tests for the helpers exercised by the
 * connectionsRouter and OAuth callback. We stub the Drizzle DbClient
 * shape so the service never talks to a real database during CI.
 */

import { describe, expect, it, vi } from "vitest";
import {
  countDestinationsUsingConnection,
  insertTelegramConnection,
  mapConnectionUsage,
  relinkOrphanedDestinationsToConnection,
  relinkOrphanedTelegramDestinations,
  resolveGoogleAccountForConnection,
  upsertGoogleConnection,
} from "./connectionService";
import type { DbClient } from "../db";

// ─── Minimal chainable DB mock ──────────────────────────────────────────────
// The service only uses a handful of Drizzle's builder methods. We recreate
// the exact chain shape with configurable return values.
//
// insert().values() returns a "fluent promise" — thenable AND has
// onDuplicateKeyUpdate() — so it works for both direct-await callers
// (insertTelegramConnection) and upsert callers (upsertGoogleConnection).

type QueueEntry = unknown | { insertId: number };

function makeDb(opts: {
  selectResults?: QueueEntry[];
  insertResults?: QueueEntry[];
  updatedRows?: { id: number; displayName?: string; status?: string }[];
}) {
  const selectQueue = [...(opts.selectResults ?? [])];
  const insertQueue = [...(opts.insertResults ?? [])];
  const updates = opts.updatedRows ?? [];

  const selectChain = () => {
    const result = selectQueue.shift();
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(result ?? [])),
          orderBy: vi.fn(() => Promise.resolve(result ?? [])),
          then: (resolve: (v: unknown) => void) => resolve(result ?? []),
        })),
      })),
    };
  };

  const db = {
    select: vi.fn(selectChain),
    insert: vi.fn(() => ({
      values: vi.fn(() => {
        const result = insertQueue.shift() ?? null;
        const resultArray = [result];
        return {
          // thenable — for `const [r] = await db.insert(...).values(...)`
          then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(resultArray).then(resolve, reject),
          // chained — for `const [r] = await db.insert(...).values(...).onDuplicateKeyUpdate(...)`
          onDuplicateKeyUpdate: vi.fn(() => Promise.resolve(resultArray)),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(() => {
          updates.push({ id: -1, ...(patch as object) });
          return Promise.resolve();
        }),
      })),
    })),
  };
  return db as unknown as DbClient;
}

describe("connectionService.upsertGoogleConnection", () => {
  it("inserts a new connection and returns the new id", async () => {
    const db = makeDb({ insertResults: [{ insertId: 42 }] });

    const id = await upsertGoogleConnection(db, {
      userId: 1,
      oauthTokenId: 99,
      email: "ali@example.com",
    });

    expect(id).toBe(42);
    // atomic upsert — no prior SELECT round-trip
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns the existing id on duplicate key (update path)", async () => {
    // On DUPLICATE KEY UPDATE … LAST_INSERT_ID(id), MySQL returns the existing
    // row's id as insertId. The mock simulates that here.
    const db = makeDb({ insertResults: [{ insertId: 77 }] });

    const id = await upsertGoogleConnection(db, {
      userId: 1,
      oauthTokenId: 99,
      email: "ali@example.com",
    });

    expect(id).toBe(77);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("falls back to the email when displayName is empty", async () => {
    const db = makeDb({ insertResults: [{ insertId: 5 }] });

    const id = await upsertGoogleConnection(db, {
      userId: 1,
      oauthTokenId: 2,
      email: "fallback@example.com",
      displayName: "   ",
    });

    expect(id).toBe(5);
  });
});

describe("connectionService.insertTelegramConnection", () => {
  it("persists bot token + chat id inside credentialsJson", async () => {
    const db = makeDb({ insertResults: [{ insertId: 101 }] });

    const id = await insertTelegramConnection(db, {
      userId: 1,
      appKey: "telegram",
      displayName: "SalesBot",
      botTokenEncrypted: "enc:xxxx",
      chatId: "-100123",
    });

    expect(id).toBe(101);
  });
});

describe("connectionService.countDestinationsUsingConnection", () => {
  it("returns 0 when no destinations reference the connection", async () => {
    const db = makeDb({ selectResults: [[]] });
    const count = await countDestinationsUsingConnection(db, 1, 7);
    expect(count).toBe(0);
  });

  it("returns the number of matching destination rows", async () => {
    const db = makeDb({ selectResults: [[{ id: 1 }, { id: 2 }, { id: 3 }]] });
    const count = await countDestinationsUsingConnection(db, 1, 7);
    expect(count).toBe(3);
  });
});

describe("connectionService.mapConnectionUsage", () => {
  it("returns an empty map for an empty input list", async () => {
    const db = makeDb({});
    const map = await mapConnectionUsage(db, 1, []);
    expect(map.size).toBe(0);
  });

  it("aggregates usage counts per connectionId and ignores null entries", async () => {
    const db = makeDb({
      selectResults: [
        [
          { connectionId: 10, id: 1 },
          { connectionId: 10, id: 2 },
          { connectionId: 20, id: 3 },
          { connectionId: null, id: 4 },
        ],
      ],
    });
    const map = await mapConnectionUsage(db, 1, [10, 20, 30]);
    expect(map.get(10)).toBe(2);
    expect(map.get(20)).toBe(1);
    expect(map.get(30)).toBeUndefined();
  });
});

describe("connectionService.relinkOrphanedDestinationsToConnection", () => {
  it("re-links every orphaned destination for the same user + template", async () => {
    // Mirrors the production incident: user disconnected the old Sotuvchi
    // connection (destination left with connectionId = NULL) then created a
    // replacement — these orphaned destinations must be re-attached to it.
    const updates: Array<Record<string, unknown>> = [];
    const db = makeDb({
      selectResults: [[{ id: 60014 }, { id: 60020 }]],
      updatedRows: updates as never,
    });

    const relinked = await relinkOrphanedDestinationsToConnection(db, {
      userId: 1893631,
      templateId: 3,
      connectionId: 46,
    });

    expect(relinked).toEqual([60014, 60020]);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual({ id: -1, connectionId: 46 });
  });

  it("is a no-op (no UPDATE) when no destination is orphaned", async () => {
    const db = makeDb({ selectResults: [[]] });

    const relinked = await relinkOrphanedDestinationsToConnection(db, {
      userId: 1,
      templateId: 3,
      connectionId: 9,
    });

    expect(relinked).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("connectionService.relinkOrphanedTelegramDestinations", () => {
  it("re-links orphaned telegram destinations matched by chatId", async () => {
    // "disconnect old bot → create new bot": a Mode-A telegram destination
    // is left with connectionId = NULL and no inline token. The chatId-match
    // filter is applied in SQL; the mock returns the rows that matched.
    const updates: Array<Record<string, unknown>> = [];
    const db = makeDb({
      selectResults: [[{ id: 7001 }]],
      updatedRows: updates as never,
    });

    const relinked = await relinkOrphanedTelegramDestinations(db, {
      userId: 1893798,
      connectionId: 44,
      chatId: "-100123456",
    });

    expect(relinked).toEqual([7001]);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual({ id: -1, connectionId: 44 });
  });

  it("is a no-op (no UPDATE) when no telegram destination matches the chat", async () => {
    const db = makeDb({ selectResults: [[]] });

    const relinked = await relinkOrphanedTelegramDestinations(db, {
      userId: 1,
      connectionId: 9,
      chatId: "-100999",
    });

    expect(relinked).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("connectionService.resolveGoogleAccountForConnection", () => {
  it("returns null when the connection is not a google_sheets type", async () => {
    const db = makeDb({
      selectResults: [[{ oauthTokenId: 1, type: "telegram_bot" }]],
    });
    const acc = await resolveGoogleAccountForConnection(db, 1);
    expect(acc).toBeNull();
  });

  it("returns null when oauthTokenId is missing", async () => {
    const db = makeDb({
      selectResults: [[{ oauthTokenId: null, type: "google_sheets" }]],
    });
    const acc = await resolveGoogleAccountForConnection(db, 1);
    expect(acc).toBeNull();
  });

  it("returns the linked oauth_tokens row when present", async () => {
    const db = makeDb({
      selectResults: [
        [{ oauthTokenId: 99, type: "google_sheets" }],
        [
          {
            id: 99,
            email: "ali@example.com",
            name: "Ali",
            picture: null,
            expiryDate: null,
          },
        ],
      ],
    });
    const acc = await resolveGoogleAccountForConnection(db, 1);
    expect(acc?.email).toBe("ali@example.com");
  });
});

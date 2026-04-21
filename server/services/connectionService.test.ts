/**
 * connectionService — unit tests for the helpers exercised by the
 * connectionsRouter and googleOAuth callback. We stub the Drizzle DbClient
 * shape so the service never talks to a real database during CI.
 */

import { describe, expect, it, vi } from "vitest";
import {
  countDestinationsUsingConnection,
  insertTelegramConnection,
  mapConnectionUsage,
  resolveGoogleAccountForConnection,
  upsertGoogleConnection,
} from "./connectionService";
import type { DbClient } from "../db";

// ─── Minimal chainable DB mock ──────────────────────────────────────────────
// The service only uses a handful of Drizzle's builder methods. We recreate
// the exact chain shape (`.select().from().where().limit()` etc.) with a
// configurable return value per call.

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
        const result = insertQueue.shift();
        return Promise.resolve([result]);
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
  it("inserts a new row when no existing connection matches", async () => {
    const db = makeDb({
      selectResults: [[]],
      insertResults: [{ insertId: 42 }],
    });

    const id = await upsertGoogleConnection(db, {
      userId: 1,
      googleAccountId: 99,
      email: "ali@example.com",
    });

    expect(id).toBe(42);
  });

  it("reuses the existing row instead of inserting a duplicate", async () => {
    const db = makeDb({
      selectResults: [[{ id: 77 }]],
    });

    const id = await upsertGoogleConnection(db, {
      userId: 1,
      googleAccountId: 99,
      email: "ali@example.com",
    });

    expect(id).toBe(77);
  });

  it("falls back to the email when displayName is empty", async () => {
    const db = makeDb({
      selectResults: [[]],
      insertResults: [{ insertId: 5 }],
    });

    const id = await upsertGoogleConnection(db, {
      userId: 1,
      googleAccountId: 2,
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

describe("connectionService.resolveGoogleAccountForConnection", () => {
  it("returns null when the connection is not a google_sheets type", async () => {
    const db = makeDb({
      selectResults: [[{ googleAccountId: 1, type: "telegram_bot" }]],
    });
    const acc = await resolveGoogleAccountForConnection(db, 1);
    expect(acc).toBeNull();
  });

  it("returns null when googleAccountId is missing", async () => {
    const db = makeDb({
      selectResults: [[{ googleAccountId: null, type: "google_sheets" }]],
    });
    const acc = await resolveGoogleAccountForConnection(db, 1);
    expect(acc).toBeNull();
  });

  it("returns the linked google_accounts row when present", async () => {
    const db = makeDb({
      selectResults: [
        [{ googleAccountId: 99, type: "google_sheets" }],
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

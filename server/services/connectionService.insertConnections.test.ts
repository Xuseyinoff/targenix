/**
 * connectionService — unit tests for the appKey-propagation fix.
 *
 * Background: PR 3 (commit c3a819a) introduced a cascade-delete sibling
 * lookup keyed on `connections.appKey`. The investigation that followed
 * found 42 of 59 prod connections had appKey=NULL because
 * `insertApiKeyConnection` and `insertTelegramConnection` never wrote
 * the column. This file pins the fix: both functions must persist
 * `appKey` from the input row.
 *
 * We stub the DbClient just enough to record the payload passed to
 * `db.insert(connections).values(...)`. No real DB.
 */

import { describe, expect, it, vi } from "vitest";

import {
  insertApiKeyConnection,
  insertTelegramConnection,
} from "./connectionService";
import type { DbClient } from "../db";

// ─── Recording DB stub ──────────────────────────────────────────────────────
//
// The original `connectionService.test.ts` mock throws away the payload
// passed to .values(). Here we explicitly capture it so we can assert on
// the appKey field. Shape matches the small subset Drizzle's
// `insert().values()` exposes: a thenable that resolves to the insertId
// array, plus an `onDuplicateKeyUpdate` chain that nothing here uses but
// keeps the type safe.

interface RecordingDb {
  db: DbClient;
  inserts: Array<{ payload: Record<string, unknown> }>;
}

function makeRecordingDb(insertId = 1001): RecordingDb {
  const inserts: Array<{ payload: Record<string, unknown> }> = [];

  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((payload: Record<string, unknown>) => {
        inserts.push({ payload });
        const resultArray = [{ insertId }];
        return {
          then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(resultArray).then(resolve, reject),
          onDuplicateKeyUpdate: vi.fn(() => Promise.resolve(resultArray)),
        };
      }),
    })),
  } as unknown as DbClient;

  return { db, inserts };
}

// ─── insertApiKeyConnection ─────────────────────────────────────────────────

describe("insertApiKeyConnection — appKey persistence", () => {
  it("writes appKey into the connections row when caller passes a string", async () => {
    const r = makeRecordingDb(101);

    const id = await insertApiKeyConnection(r.db, {
      userId: 1,
      templateId: 3,
      appKey: "sotuvchi",
      displayName: "Sotuvchi.com — key",
      secretsEncrypted: { api_key: "enc:BD...XK" },
    });

    expect(id).toBe(101);
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]!.payload.appKey).toBe("sotuvchi");
    // Type still matches the column shape (api_key, with templateId in
    // credentialsJson). Spot-check the rest of the payload didn't drift.
    expect(r.inserts[0]!.payload.type).toBe("api_key");
    expect(r.inserts[0]!.payload.displayName).toBe("Sotuvchi.com — key");
    expect((r.inserts[0]!.payload.credentialsJson as { templateId: number }).templateId).toBe(3);
  });

  it("writes appKey=null when caller passes null (defensive — column is nullable)", async () => {
    // A future template without an appKey would route through this path.
    // The function must NOT throw — it just stores NULL, which the cascade
    // sibling lookup then naturally skips.
    const r = makeRecordingDb(102);

    const id = await insertApiKeyConnection(r.db, {
      userId: 1,
      templateId: 99,
      appKey: null,
      displayName: "Mystery template",
      secretsEncrypted: { api_key: "enc:zzz" },
    });

    expect(id).toBe(102);
    expect(r.inserts[0]!.payload.appKey).toBeNull();
  });
});

// ─── insertTelegramConnection ───────────────────────────────────────────────

describe("insertTelegramConnection — appKey persistence", () => {
  it("writes appKey='telegram' when caller passes the literal", async () => {
    const r = makeRecordingDb(201);

    const id = await insertTelegramConnection(r.db, {
      userId: 5,
      appKey: "telegram",
      displayName: "Sales bot",
      botTokenEncrypted: "enc:bot-token",
      chatId: "-100777",
    });

    expect(id).toBe(201);
    expect(r.inserts[0]!.payload.appKey).toBe("telegram");
    expect(r.inserts[0]!.payload.type).toBe("telegram_bot");
    // chatId still trimmed and credentialsJson still intact — spot check
    // the function body didn't accidentally drop fields while we added
    // the appKey field.
    expect(
      (r.inserts[0]!.payload.credentialsJson as { chatId: string }).chatId,
    ).toBe("-100777");
  });

  it("accepts appKey=null without throwing (parity with insertApiKeyConnection)", async () => {
    const r = makeRecordingDb(202);

    const id = await insertTelegramConnection(r.db, {
      userId: 5,
      appKey: null,
      displayName: "Mystery bot",
      botTokenEncrypted: "enc:x",
      chatId: "0",
    });

    expect(id).toBe(202);
    expect(r.inserts[0]!.payload.appKey).toBeNull();
  });
});

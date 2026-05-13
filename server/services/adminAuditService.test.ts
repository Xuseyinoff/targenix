/**
 * adminAuditService — unit tests for sanitization + recording.
 *
 * Coverage:
 *   - sanitizeAuditInput: secret-key redaction (case-insensitive,
 *     substring match), string/array/depth truncation, circular refs,
 *     serialized-size clamp.
 *   - recordAdminAction: shape of the inserted row, defensive trimming
 *     of overlong free-form fields, failure-path swallowing.
 */

import { describe, it, expect, vi } from "vitest";
import { sanitizeAuditInput, recordAdminAction } from "./adminAuditService";
import type { DbClient } from "../db";

// ─── sanitizeAuditInput ─────────────────────────────────────────────────────

describe("sanitizeAuditInput — secret redaction", () => {
  it("redacts well-known sensitive keys", () => {
    const out = sanitizeAuditInput({
      password: "hunter2",
      api_key: "sk-abcdef",
      token: "bearer-xyz",
      secret: "shh",
      normal: "visible",
    }) as Record<string, unknown>;

    expect(out.password).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.normal).toBe("visible");
  });

  it("is case-insensitive and matches as a substring", () => {
    const out = sanitizeAuditInput({
      apiKey: "sk-x",
      "API-KEY": "sk-y",
      passwordHash: "$argon2…",
      userToken: "abc",
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe("[REDACTED]");
    expect(out["API-KEY"]).toBe("[REDACTED]");
    expect(out.passwordHash).toBe("[REDACTED]");
    expect(out.userToken).toBe("[REDACTED]");
  });

  it("redacts sensitive keys nested in objects", () => {
    const out = sanitizeAuditInput({
      config: {
        host: "smtp.example.com",
        credentials: { user: "admin", password: "hunter2" },
      },
    }) as { config: { host: string; credentials: unknown } };

    expect(out.config.host).toBe("smtp.example.com");
    expect(out.config.credentials).toBe("[REDACTED]");
  });
});

describe("sanitizeAuditInput — size and shape limits", () => {
  it("truncates strings longer than the cap", () => {
    const long = "x".repeat(2000);
    const out = sanitizeAuditInput({ note: long }) as { note: string };
    expect(out.note.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    expect(out.note.endsWith("…")).toBe(true);
  });

  it("caps arrays at MAX_ARRAY_LEN and reports excess", () => {
    const big = Array.from({ length: 75 }, (_, i) => i);
    const out = sanitizeAuditInput({ items: big }) as { items: unknown[] };
    expect(out.items.length).toBe(51); // 50 entries + 1 truncation marker
    expect(out.items[50]).toBe("[…+25 more]");
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = sanitizeAuditInput(a) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[CIRCULAR]");
  });

  it("caps deep nesting", () => {
    let leaf: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 12; i++) leaf = { child: leaf };
    const out = sanitizeAuditInput(leaf);
    const serialized = JSON.stringify(out);
    expect(serialized).toContain("[TRUNCATED depth]");
  });

  it("returns a __truncated marker when serialized payload exceeds size limit", () => {
    const huge = "y".repeat(MAX_STRING_LEN_PROBE - 1);
    const big = Array.from({ length: 50 }, () => ({ chunk: huge }));
    const out = sanitizeAuditInput({ blocks: big }) as Record<string, unknown>;
    expect(out.__truncated).toBe(true);
    expect(typeof out.bytes).toBe("number");
  });

  it("preserves primitives untouched", () => {
    expect(sanitizeAuditInput(42)).toBe(42);
    expect(sanitizeAuditInput(true)).toBe(true);
    expect(sanitizeAuditInput(null)).toBe(null);
    expect(sanitizeAuditInput("short")).toBe("short");
  });

  it("drops functions and symbols", () => {
    const out = sanitizeAuditInput({
      keep: 1,
      fn: () => 2,
      sym: Symbol("x"),
    }) as Record<string, unknown>;
    expect(out.keep).toBe(1);
    expect(out.fn).toBeUndefined();
    expect(out.sym).toBeUndefined();
  });
});

// Helper constant — probe value larger than the string truncation cap so
// the clamp path triggers regardless of the internal MAX_STRING_LEN.
const MAX_STRING_LEN_PROBE = 500;

// ─── recordAdminAction ─────────────────────────────────────────────────────

function makeRecordingDb(): {
  db: DbClient;
  inserts: unknown[];
} {
  const inserts: unknown[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        inserts.push(row);
        return Promise.resolve([{ insertId: inserts.length }]);
      }),
    })),
  } as unknown as DbClient;
  return { db, inserts };
}

describe("recordAdminAction — successful insert path", () => {
  it("writes a row with the expected shape on success", async () => {
    const { db, inserts } = makeRecordingDb();
    await recordAdminAction(db, {
      adminId: 7,
      path: "adminApps.create",
      type: "mutation",
      input: { appKey: "telegram", displayName: "Telegram Bot" },
      resultStatus: "success",
      durationMs: 23,
      ipAddress: "10.0.0.1",
      userAgent: "Mozilla/5.0",
    });

    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.adminId).toBe(7);
    expect(row.path).toBe("adminApps.create");
    expect(row.type).toBe("mutation");
    expect(row.resultStatus).toBe("success");
    expect(row.errorCode).toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.durationMs).toBe(23);
    expect(row.ipAddress).toBe("10.0.0.1");
    expect(row.userAgent).toBe("Mozilla/5.0");
    expect(row.input).toEqual({ appKey: "telegram", displayName: "Telegram Bot" });
  });

  it("redacts secrets in the persisted input", async () => {
    const { db, inserts } = makeRecordingDb();
    await recordAdminAction(db, {
      adminId: 7,
      path: "adminApps.update",
      type: "mutation",
      input: { appKey: "x", patch: { api_key: "sk-leak", name: "X" } },
      resultStatus: "success",
      durationMs: 5,
    });

    const row = inserts[0] as { input: { patch: Record<string, unknown> } };
    expect(row.input.patch.api_key).toBe("[REDACTED]");
    expect(row.input.patch.name).toBe("X");
  });

  it("captures failure status with error code + message", async () => {
    const { db, inserts } = makeRecordingDb();
    await recordAdminAction(db, {
      adminId: 7,
      path: "adminDlq.replayOne",
      type: "mutation",
      input: { orderId: 999 },
      resultStatus: "failure",
      errorCode: "BAD_REQUEST",
      errorMessage: "Order 999 not found",
      durationMs: 12,
    });

    const row = inserts[0] as Record<string, unknown>;
    expect(row.resultStatus).toBe("failure");
    expect(row.errorCode).toBe("BAD_REQUEST");
    expect(row.errorMessage).toBe("Order 999 not found");
  });

  it("trims oversized free-form fields to column limits", async () => {
    const { db, inserts } = makeRecordingDb();
    await recordAdminAction(db, {
      adminId: 7,
      path: "z".repeat(200),                // exceeds 128
      type: "mutation",
      input: null,
      resultStatus: "failure",
      errorCode: "INTERNAL_SERVER_ERROR",
      errorMessage: "e".repeat(2000),       // exceeds 500
      userAgent: "u".repeat(400),           // exceeds 256
      ipAddress: "i".repeat(200),           // exceeds 64
      durationMs: 1,
    });

    const row = inserts[0] as Record<string, string>;
    expect(row.path.length).toBe(128);
    expect(row.errorMessage.length).toBe(500);
    expect(row.userAgent.length).toBe(256);
    expect(row.ipAddress.length).toBe(64);
  });

  it("never throws when the DB insert rejects (best-effort contract)", async () => {
    const explodingDb = {
      insert: vi.fn(() => ({
        values: vi.fn(() => Promise.reject(new Error("deadlock"))),
      })),
    } as unknown as DbClient;

    await expect(
      recordAdminAction(explodingDb, {
        adminId: 7,
        path: "adminApps.create",
        type: "mutation",
        input: {},
        resultStatus: "success",
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats undefined input as NULL in the row", async () => {
    const { db, inserts } = makeRecordingDb();
    await recordAdminAction(db, {
      adminId: 7,
      path: "adminLeads.retryAll",
      type: "mutation",
      input: undefined,
      resultStatus: "success",
      durationMs: 1,
    });
    expect((inserts[0] as { input: unknown }).input).toBeNull();
  });

  it("clamps negative or fractional durations to a safe integer", async () => {
    const { db, inserts } = makeRecordingDb();
    await recordAdminAction(db, {
      adminId: 7,
      path: "adminApps.create",
      type: "mutation",
      input: {},
      resultStatus: "success",
      durationMs: -42.7,
    });
    expect((inserts[0] as { durationMs: number }).durationMs).toBe(0);
  });
});

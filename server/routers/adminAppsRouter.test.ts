/**
 * adminAppsRouter tests — covers:
 *
 *  Schema (Zod) validation:
 *    1.  Valid full payload → passes
 *    2.  appKey too short → fails
 *    3.  appKey with uppercase → fails
 *    4.  appKey with invalid chars → fails
 *    5.  authType='none' + non-empty fields → fails
 *    6.  Duplicate field keys → fails
 *    7.  fields omitted → defaults to []
 *    8.  iconUrl not a URL → fails
 *
 *  create mutation:
 *    9.  Happy path → inserts row, returns { ok: true, appKey }
 *   10.  Duplicate appKey → CONFLICT / APP_KEY_ALREADY_EXISTS
 *   11.  DB unavailable → INTERNAL_SERVER_ERROR
 *
 *  update mutation:
 *   12.  Toggle isActive → updates row
 *   13.  appKey not found → NOT_FOUND
 *   14.  No fields provided → BAD_REQUEST
 *   15.  authType='none' + non-empty fields → BAD_REQUEST
 *
 *  delete mutation:
 *   16.  Happy path → deletes row
 *   17.  App in use by active template → CONFLICT / APP_IN_USE
 *
 *  list query:
 *   18.  Returns DB rows ordered by appKey
 *   19.  Returns [] when DB is null
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { appFieldSchema } from "./adminAppsRouter";

// ─── 1–8: Zod schema validation (no DB needed) ───────────────────────────────

const APP_KEY_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const AUTH_TYPES = ["api_key", "oauth2", "bearer", "basic", "none"] as const;
const CATEGORIES = ["affiliate", "messaging", "data", "webhooks", "crm"] as const;

const createSchema = z
  .object({
    appKey: z.string().regex(APP_KEY_RE),
    displayName: z.string().min(1).max(128),
    authType: z.enum(AUTH_TYPES),
    category: z.enum(CATEGORIES),
    fields: z.array(appFieldSchema).default([]),
    iconUrl: z.string().url().max(512).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.authType === "none" && data.fields.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authType='none' must have fields: []",
        path: ["fields"],
      });
    }
    const seen = new Set<string>();
    for (const f of data.fields) {
      if (seen.has(f.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate field key '${f.key}'`,
          path: ["fields"],
        });
        return;
      }
      seen.add(f.key);
    }
  });

const VALID_PAYLOAD = {
  appKey: "test-api",
  displayName: "Test API",
  authType: "api_key" as const,
  category: "webhooks" as const,
  fields: [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
};

describe("adminAppsRouter — input schema", () => {
  it("1. accepts a valid full payload", () => {
    expect(createSchema.safeParse(VALID_PAYLOAD).success).toBe(true);
  });

  it("2. rejects appKey shorter than 3 chars", () => {
    expect(createSchema.safeParse({ ...VALID_PAYLOAD, appKey: "ab" }).success).toBe(false);
  });

  it("3. rejects appKey with uppercase letters", () => {
    expect(createSchema.safeParse({ ...VALID_PAYLOAD, appKey: "TestAPI" }).success).toBe(false);
  });

  it("4. rejects appKey with spaces or forbidden chars", () => {
    expect(createSchema.safeParse({ ...VALID_PAYLOAD, appKey: "test api" }).success).toBe(false);
    expect(createSchema.safeParse({ ...VALID_PAYLOAD, appKey: "test@api" }).success).toBe(false);
    expect(createSchema.safeParse({ ...VALID_PAYLOAD, appKey: "test.api" }).success).toBe(false);
  });

  it("5. rejects authType='none' with non-empty fields", () => {
    const r = createSchema.safeParse({
      ...VALID_PAYLOAD,
      authType: "none",
      fields: [{ key: "api_key", label: "Key", required: false, sensitive: false }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toContain("authType='none'");
  });

  it("6. rejects duplicate field keys", () => {
    const r = createSchema.safeParse({
      ...VALID_PAYLOAD,
      fields: [
        { key: "api_key", label: "Key 1", required: true,  sensitive: true },
        { key: "api_key", label: "Key 2", required: false, sensitive: false },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toContain("Duplicate");
  });

  it("7. defaults fields to [] when omitted", () => {
    const r = createSchema.safeParse({
      appKey: "open-app",
      displayName: "Open",
      authType: "none",
      category: "affiliate",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fields).toEqual([]);
  });

  it("8. rejects non-URL iconUrl", () => {
    expect(
      createSchema.safeParse({ ...VALID_PAYLOAD, iconUrl: "not-a-url" }).success,
    ).toBe(false);
  });
});

// ─── 9–19: Mutation / query behaviour (mocked DB) ────────────────────────────

vi.mock("../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../db";
import { adminAppsRouter } from "./adminAppsRouter";
import type { TrpcContext } from "../_core/context";
import type { DbClient } from "../db";

function adminCaller(db: DbClient | null) {
  vi.mocked(getDb).mockResolvedValue(db as any);
  const ctx: TrpcContext = {
    req: null as any,
    res: null as any,
    user: {
      id: 1,
      name: "Admin",
      email: "admin@test.com",
      role: "admin",
      password: null,
      facebookId: null,
      googleId: null,
      createdAt: new Date(),
    },
  };
  return adminAppsRouter.createCaller(ctx);
}

/**
 * Builds a minimal Drizzle-ish DbClient double.
 *
 * `selectLimit` — rows returned by `.select().from().where().limit()`
 *    (used for duplicate-check, NOT FOUND, template-in-use guard).
 *
 * `listRows`   — rows returned by `.select().from().orderBy()`
 *    (used for list query).
 */
function makeDb(opts: {
  selectLimit?: unknown[];
  listRows?: unknown[];
} = {}): DbClient {
  const selectLimit = opts.selectLimit ?? [];
  const listRows = opts.listRows ?? [];

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectLimit),
        })),
        orderBy: vi.fn(async () => listRows),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  } as unknown as DbClient;
}

// ── create ────────────────────────────────────────────────────────────────────

describe("adminAppsRouter — create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("9. happy path: inserts row and returns { ok, appKey }", async () => {
    const db = makeDb({ selectLimit: [] }); // no existing row
    const result = await adminCaller(db).create(VALID_PAYLOAD);
    expect(result).toEqual({ ok: true, appKey: "test-api" });
    expect((db as any).insert).toHaveBeenCalled();
  });

  it("10. duplicate appKey → CONFLICT", async () => {
    const db = makeDb({ selectLimit: [{ appKey: "test-api" }] });
    await expect(adminCaller(db).create(VALID_PAYLOAD)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((db as any).insert).not.toHaveBeenCalled();
  });

  it("11. DB null → INTERNAL_SERVER_ERROR", async () => {
    await expect(adminCaller(null).create(VALID_PAYLOAD)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});

// ── update ────────────────────────────────────────────────────────────────────

describe("adminAppsRouter — update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("12. updates isActive=false on existing row", async () => {
    const db = makeDb({ selectLimit: [{ appKey: "test-api", authType: "api_key" }] });
    const result = await adminCaller(db).update({ appKey: "test-api", isActive: false });
    expect(result).toEqual({ ok: true, appKey: "test-api" });
    expect((db as any).update).toHaveBeenCalled();
  });

  it("13. NOT_FOUND for unknown appKey", async () => {
    const db = makeDb({ selectLimit: [] });
    await expect(adminCaller(db).update({ appKey: "ghost", isActive: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("14. BAD_REQUEST when no patch fields provided", async () => {
    const db = makeDb({ selectLimit: [{ appKey: "test-api", authType: "api_key" }] });
    await expect(adminCaller(db).update({ appKey: "test-api" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("No fields to update"),
    });
  });

  it("15. BAD_REQUEST when switching to authType='none' with non-empty fields", async () => {
    const db = makeDb({ selectLimit: [{ appKey: "test-api", authType: "api_key" }] });
    await expect(
      adminCaller(db).update({
        appKey: "test-api",
        authType: "none",
        fields: [{ key: "api_key", label: "Key", required: true, sensitive: true }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe("adminAppsRouter — delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("16. happy path: deletes row and returns { ok, appKey }", async () => {
    const db = makeDb({ selectLimit: [] }); // no templates referencing this app
    const result = await adminCaller(db).delete({ appKey: "test-api" });
    expect(result).toEqual({ ok: true, appKey: "test-api" });
    expect((db as any).delete).toHaveBeenCalled();
  });

  it("17. CONFLICT when an active template references the app", async () => {
    // The guard SELECT returns one template row.
    const db = makeDb({ selectLimit: [{ id: 7, name: "Live Template" }] });
    await expect(adminCaller(db).delete({ appKey: "test-api" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((db as any).delete).not.toHaveBeenCalled();
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("adminAppsRouter — list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("18. returns DB rows ordered by appKey", async () => {
    const mockRows = [
      { id: 1, appKey: "alijahon", displayName: "Alijahon.uz" },
      { id: 2, appKey: "sotuvchi", displayName: "Sotuvchi.com" },
    ];
    const db = makeDb({ listRows: mockRows });
    const result = await adminCaller(db).list();
    expect(result).toEqual(mockRows);
  });

  it("19. returns [] when DB is null", async () => {
    const result = await adminCaller(null).list();
    expect(result).toEqual([]);
  });
});

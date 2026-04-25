/**
 * Stage 1 — admin template contract tests.
 *
 * Covers every test case listed in the stage spec:
 *
 *   1. Valid template with {{SECRET:api_key}} → OK
 *   2. Invalid {{SECRET:wrong_key}} → FAIL (SECRET_KEY_UNDECLARED)
 *   3. Literal "abc123" in secret field → FAIL (SECRET_FIELD_NOT_TOKEN)
 *   4. Missing appKey → FAIL (APP_KEY_MISSING)
 *   5. Unknown appKey → FAIL (APP_KEY_UNKNOWN)
 *   6. Boot with broken template → FAIL (TemplatesContractBootError)
 *
 * The boot test stubs `getDb` to return a fake Drizzle-ish query
 * builder so we can exercise the code path without a live MySQL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateTemplateContract,
  TemplateContractError,
  SECRET_TOKEN_RE,
  extractSecretKeys,
} from "./integrations/validateTemplateContract";

// ─── validateTemplateContract (Step B — async, DB-first) ─────────────────────

import type { AppRow } from "../drizzle/schema";
import type { DbClient } from "./db";

/** Build a mock DbClient that returns `rows` for any select chain. */
function makeDb(rows: Partial<AppRow>[]): DbClient {
  const chain = {
    from: () => chain,
    where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
  };
  return { select: vi.fn(() => chain) } as unknown as DbClient;
}

/** Full AppRow from a minimal partial (fields default to api_key spec). */
function appRow(partial: Partial<AppRow> & Pick<AppRow, "appKey" | "displayName">): AppRow {
  return {
    id: 1,
    appKey: partial.appKey,
    displayName: partial.displayName,
    category: partial.category ?? "affiliate",
    authType: partial.authType ?? "api_key",
    fields: partial.fields ?? [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
    oauthConfig: null,
    iconUrl: null,
    docsUrl: null,
    isActive: true,
    createdAt: new Date("2025-01-01"),
  };
}

describe("validateTemplateContract — pure contract checks", () => {
  it("accepts a well-formed template with {{SECRET:api_key}} (case 1)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
          { key: "name",    value: "{{name}}",           isSecret: false },
          { key: "phone",   value: "{{phone}}",          isSecret: false },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a secret field pointing at an undeclared key (case 2)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [{ key: "api_key", value: "{{SECRET:wrong_key}}", isSecret: true }],
      }),
    ).rejects.toMatchObject({ code: "SECRET_KEY_UNDECLARED", details: { appKey: "sotuvchi", secretKey: "wrong_key" } });
  });

  it("rejects a literal value in a secret field (case 3)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [{ key: "api_key", value: "sk_live_abc123", isSecret: true }],
      }),
    ).rejects.toMatchObject({ code: "SECRET_FIELD_NOT_TOKEN" });
  });

  it("rejects a template with no appKey (case 4)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "",
        bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }],
      }),
    ).rejects.toMatchObject({ code: "APP_KEY_MISSING" });
  });

  it("rejects a template whose appKey is not declared in specs (case 5)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "nonexistent-app",
        bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }],
      }),
    ).rejects.toMatchObject({ code: "APP_KEY_UNKNOWN" });
  });

  it("rejects a non-secret field that smuggles a SECRET token to an undeclared key", async () => {
    await expect(
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [{ key: "stream", value: "prefix {{SECRET:mystery}}", isSecret: false }],
      }),
    ).rejects.toMatchObject({ code: "SECRET_KEY_UNDECLARED" });
  });

  it("rejects a malformed SECRET token (wrong casing)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [{ key: "x", value: "{{SECRET:API_KEY}}", isSecret: false }],
      }),
    ).rejects.toMatchObject({ code: "SECRET_TOKEN_MALFORMED" });
  });

  it("validates headers with the same rules", async () => {
    await expect(
      validateTemplateContract({
        appKey: "100k",
        bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }],
        headers: { Authorization: "Bearer {{SECRET:api_key}}" },
      }),
    ).resolves.toBeDefined();

    await expect(
      validateTemplateContract({
        appKey: "100k",
        bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }],
        headers: { Authorization: "Bearer {{SECRET:undeclared}}" },
      }),
    ).rejects.toMatchObject({ code: "SECRET_KEY_UNDECLARED" });
  });

  it("SECRET_TOKEN_RE is anchored and case-sensitive", () => {
    expect(SECRET_TOKEN_RE.test("{{SECRET:api_key}}")).toBe(true);
    expect(SECRET_TOKEN_RE.test(" {{SECRET:api_key}}")).toBe(false);
    expect(SECRET_TOKEN_RE.test("{{secret:api_key}}")).toBe(false);
    expect(SECRET_TOKEN_RE.test("{{SECRET:API_KEY}}")).toBe(false);
    expect(SECRET_TOKEN_RE.test("{{SECRET:api-key}}")).toBe(false);
    expect(SECRET_TOKEN_RE.test("{{SECRET:_api_key}}")).toBe(false);
  });

  it("extractSecretKeys returns every token in order", () => {
    expect(extractSecretKeys("x={{SECRET:a}} y={{SECRET:b}} z={{SECRET:a}}")).toEqual(["a", "b", "a"]);
  });

  // ── authType: 'none' ─────────────────────────────────────────────────────

  it("accepts an authless template with no secret fields (authType='none')", async () => {
    await expect(
      validateTemplateContract({
        appKey: "open_affiliate",
        bodyFields: [
          { key: "name",  value: "{{name}}",  isSecret: false },
          { key: "phone", value: "{{phone}}", isSecret: false },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a secret field on an authless template (AUTH_NONE_HAS_SECRETS)", async () => {
    await expect(
      validateTemplateContract({
        appKey: "open_affiliate",
        bodyFields: [
          { key: "name",    value: "{{name}}",           isSecret: false },
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true  },
        ],
      }),
    ).rejects.toMatchObject({ code: "AUTH_NONE_HAS_SECRETS" });
  });

  it("rejects a {{SECRET:…}} token inside a non-secret field on an authless template", async () => {
    await expect(
      validateTemplateContract({
        appKey: "open_affiliate",
        bodyFields: [{ key: "note", value: "lead from {{SECRET:api_key}}", isSecret: false }],
      }),
    ).rejects.toMatchObject({ code: "AUTH_NONE_HAS_SECRETS" });
  });

  it("rejects a {{SECRET:…}} token inside a header on an authless template", async () => {
    await expect(
      validateTemplateContract({
        appKey: "open_affiliate",
        bodyFields: [{ key: "name", value: "{{name}}", isSecret: false }],
        headers: { Authorization: "Bearer {{SECRET:api_key}}" },
      }),
    ).rejects.toMatchObject({ code: "AUTH_NONE_HAS_SECRETS" });
  });

  // ── Step B: DB-first spec resolution ────────────────────────────────────

  it("resolves from DB when appKey exists only in apps table (not in TS constant)", async () => {
    const db = makeDb([
      appRow({
        appKey: "__db_only_app__",
        displayName: "DB-Only App",
        fields: [{ key: "token", label: "Token", required: true, sensitive: true }],
      }),
    ]);
    const spec = await validateTemplateContract({
      appKey: "__db_only_app__",
      bodyFields: [{ key: "token", value: "{{SECRET:token}}", isSecret: true }],
      db,
    });
    expect(spec.appKey).toBe("__db_only_app__");
    expect(spec.displayName).toBe("DB-Only App");
  });

  it("fails APP_KEY_UNKNOWN for DB-only app when db is not provided", async () => {
    await expect(
      validateTemplateContract({
        appKey: "__db_only_app__",
        bodyFields: [{ key: "token", value: "{{SECRET:token}}", isSecret: true }],
      }),
    ).rejects.toMatchObject({ code: "APP_KEY_UNKNOWN" });
  });

  it("specOverride takes priority over db lookup (boot efficiency path)", async () => {
    // DB would return nothing for this key, but specOverride supplies the spec
    const db = makeDb([]);
    const override = { appKey: "fake", displayName: "Override", authType: "api_key" as const, category: "affiliate" as const, fields: [] };
    const spec = await validateTemplateContract({
      appKey: "fake",
      bodyFields: [],
      db,
      specOverride: override,
    });
    expect(spec.displayName).toBe("Override");
  });

  it("falls back to TS constant when db returns no row", async () => {
    const db = makeDb([]); // empty DB
    const spec = await validateTemplateContract({
      appKey: "sotuvchi",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }],
      db,
    });
    expect(spec.appKey).toBe("sotuvchi");
  });
});

// ─── validateTemplatesAtBoot (DB-stubbed) ────────────────────────────────────

describe("validateTemplatesAtBoot — aborts on broken templates (case 6)", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(() => {
    vi.resetModules();
  });

  async function withFakeDb(rows: Array<{
    id: number;
    name: string;
    appKey: string | null;
    bodyFields: unknown;
  }>) {
    // Build a minimal Drizzle-ish chain: select(...).from(...).where(...) → rows
    const chain = {
      from: () => chain,
      where: async () => rows,
    };
    const fakeDb = {
      select: () => chain,
    };

    vi.doMock("./db", () => ({
      getDb: async () => fakeDb,
    }));

    const mod = await import("./boot/validateTemplatesContract");
    return mod;
  }

  it("resolves for an all-valid template set", async () => {
    const { validateTemplatesAtBoot } = await withFakeDb([
      {
        id: 1,
        name: "Sotuvchi",
        appKey: "sotuvchi",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
          { key: "name", value: "{{name}}", isSecret: false },
        ],
      },
    ]);

    const r = await validateTemplatesAtBoot();
    expect(r.ok).toBe(true);
    expect(r.validatedTemplates).toBe(1);
    expect(r.knownApps).toBeGreaterThan(0);
  });

  it("throws TemplatesContractBootError when an active template is broken", async () => {
    const { validateTemplatesAtBoot, TemplatesContractBootError } =
      await withFakeDb([
        {
          id: 42,
          name: "Broken",
          appKey: "sotuvchi",
          bodyFields: [
            // secret key not declared in spec → should fail
            { key: "api_key", value: "{{SECRET:not_declared}}", isSecret: true },
          ],
        },
      ]);

    await expect(validateTemplatesAtBoot()).rejects.toBeInstanceOf(
      TemplatesContractBootError,
    );

    try {
      await validateTemplatesAtBoot();
    } catch (err) {
      expect((err as InstanceType<typeof TemplatesContractBootError>).failures).toHaveLength(1);
      expect(
        (err as InstanceType<typeof TemplatesContractBootError>).failures[0]
          .code,
      ).toBe("SECRET_KEY_UNDECLARED");
    }
  });

  it("lists every failing template at once, not just the first", async () => {
    const { validateTemplatesAtBoot, TemplatesContractBootError } =
      await withFakeDb([
        {
          id: 1,
          name: "NoAppKey",
          appKey: null,
          bodyFields: [
            { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
          ],
        },
        {
          id: 2,
          name: "Literal",
          appKey: "sotuvchi",
          bodyFields: [
            { key: "api_key", value: "sk_live_abc", isSecret: true },
          ],
        },
      ]);

    try {
      await validateTemplatesAtBoot();
      throw new Error("expected boot validator to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplatesContractBootError);
      const failures =
        (err as InstanceType<typeof TemplatesContractBootError>).failures;
      expect(failures.map((f) => f.code).sort()).toEqual([
        "APP_KEY_MISSING",
        "SECRET_FIELD_NOT_TOKEN",
      ]);
    }
  });
});

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

// ─── validateTemplateContract (pure) ─────────────────────────────────────────

describe("validateTemplateContract — pure contract checks", () => {
  it("accepts a well-formed template with {{SECRET:api_key}} (case 1)", () => {
    expect(() =>
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
          { key: "name",    value: "{{name}}",           isSecret: false },
          { key: "phone",   value: "{{phone}}",          isSecret: false },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a secret field pointing at an undeclared key (case 2)", () => {
    try {
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:wrong_key}}", isSecret: true },
        ],
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("SECRET_KEY_UNDECLARED");
      expect((err as TemplateContractError).details).toMatchObject({
        appKey: "sotuvchi",
        secretKey: "wrong_key",
      });
    }
  });

  it("rejects a literal value in a secret field (case 3)", () => {
    try {
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [
          { key: "api_key", value: "sk_live_abc123", isSecret: true },
        ],
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("SECRET_FIELD_NOT_TOKEN");
    }
  });

  it("rejects a template with no appKey (case 4)", () => {
    try {
      validateTemplateContract({
        appKey: "",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
        ],
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("APP_KEY_MISSING");
    }
  });

  it("rejects a template whose appKey is not declared in specs (case 5)", () => {
    try {
      validateTemplateContract({
        appKey: "nonexistent-app",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
        ],
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("APP_KEY_UNKNOWN");
    }
  });

  it("rejects a non-secret field that smuggles a SECRET token to an undeclared key", () => {
    try {
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [
          { key: "stream", value: "prefix {{SECRET:mystery}}", isSecret: false },
        ],
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("SECRET_KEY_UNDECLARED");
    }
  });

  it("rejects a malformed SECRET token (wrong casing)", () => {
    try {
      validateTemplateContract({
        appKey: "sotuvchi",
        bodyFields: [
          { key: "x", value: "{{SECRET:API_KEY}}", isSecret: false },
        ],
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("SECRET_TOKEN_MALFORMED");
    }
  });

  it("validates headers with the same rules", () => {
    expect(() =>
      validateTemplateContract({
        appKey: "100k",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
        ],
        headers: { Authorization: "Bearer {{SECRET:api_key}}" },
      }),
    ).not.toThrow();

    try {
      validateTemplateContract({
        appKey: "100k",
        bodyFields: [
          { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
        ],
        headers: { Authorization: "Bearer {{SECRET:undeclared}}" },
      });
      throw new Error("expected TemplateContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateContractError);
      expect((err as TemplateContractError).code).toBe("SECRET_KEY_UNDECLARED");
    }
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
    expect(
      extractSecretKeys(
        "x={{SECRET:a}} y={{SECRET:b}} z={{SECRET:a}}",
      ),
    ).toEqual(["a", "b", "a"]);
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

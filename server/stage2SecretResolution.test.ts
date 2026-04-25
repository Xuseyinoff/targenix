/**
 * Secret resolution — `resolveSecretsForDelivery` contract tests.
 *
 * Covers the scenarios for connection-backed secret resolution:
 *
 *   1. No connection → throws ConnectionRequiredError (connection required).
 *   2. Active connection with secrets → connection's map is the source of truth.
 *   3. Connection rotation → mutating the connection's secrets map
 *      is reflected on the next resolve call (no stale copy).
 *   4. Missing secret → a connection that was explicitly linked but
 *      contains no secrets throws `ConnectionSecretMissingError`.
 *   5. Non-active connection (expired/revoked) → treated as no connection
 *      → throws ConnectionRequiredError.
 *   6. Auth-less appKey → short-circuits to {} regardless of connection state.
 *
 * No axios call is ever made — these are byte-level assertions on the
 * body / headers produced by the delivery builder, so they run in
 * milliseconds and need no DB or network stubs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  ConnectionRequiredError,
  ConnectionSecretMissingError,
  buildCustomBody,
  buildHeaders,
  buildVariableContext,
  resolveSecretsForDelivery,
} from "./services/affiliateService";
import { encrypt } from "./encryption";
import type { Connection } from "../drizzle/schema";
import type { DbClient } from "./db";

// ─── Test fixtures ──────────────────────────────────────────────────────────
const sampleLead = {
  leadgenId: "lead_stage2",
  fullName: "Ali Valiyev",
  phone: "+998901234567",
  email: "ali@example.com",
  pageId: "page_s2",
  formId: "form_s2",
};

/**
 * Build a minimal `Connection` row for the delivery path. Only the
 * fields read by `resolveSecretsForDelivery` need realistic values
 * (`status`, `credentialsJson`, `id`, `userId`); everything else
 * gets safe defaults that exercise the non-happy-path branches too.
 */
function makeConnection(overrides: Partial<Connection> = {}): Connection {
  const base: Connection = {
    id: 777,
    userId: 1,
    type: "api_key",
    appKey: "alijahon",
    displayName: "Alijahon.uz",
    status: "active",
    googleAccountId: null,
    credentialsJson: { secretsEncrypted: {} },
    lastVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}

/**
 * Build a minimal Drizzle-ish DbClient that returns a single `apps` row
 * for the given appKey when `resolveSpecSafe` queries it. Used by authless
 * tests so the spec is resolved from a DB mock rather than a TS constant
 * (which was removed in Step C).
 */
function makeAuthlessDb(appKey: string): DbClient {
  const row = {
    id: 1,
    appKey,
    displayName: appKey,
    authType: "none",
    category: "affiliate",
    fields: [],
    oauthConfig: null,
    iconUrl: null,
    docsUrl: null,
    isActive: true,
    createdAt: new Date(),
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [row]),
        })),
      })),
    })),
  } as unknown as DbClient;
}

describe("Stage 2 — resolveSecretsForDelivery", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "stage-2-unit-test-key-do-not-use-in-prod";
  });
  afterAll(() => {
    if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  // ── Test 1 — No connection → ConnectionRequiredError ────────────────────
  it("(1) no connection → throws ConnectionRequiredError", async () => {
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("(1b) no connection AND no templateConfig.secrets → still throws ConnectionRequiredError", async () => {
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: {},
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("(1c) connection=undefined → throws ConnectionRequiredError", async () => {
    await expect(
      resolveSecretsForDelivery({
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  // ── Test 2 — New destination with connection → connection wins ──────────
  it("(2) active connection with secrets → returns connection's map", async () => {
    const cipherConn = encrypt("from-connection");
    const cipherLegacy = encrypt("from-legacy");
    const out = await resolveSecretsForDelivery({
      connection: makeConnection({
        credentialsJson: { secretsEncrypted: { api_key: cipherConn } },
      }),
      // Legacy map is ignored when a connection is active.
      templateConfig: { secrets: { api_key: cipherLegacy } },
      adapterContext: "dynamic-template",
    });
    expect(out).toEqual({ api_key: cipherConn });
  });

  // ── Test 3 — Key rotation flows through on every call ───────────────────
  it("(3) mutating the connection's secrets is reflected immediately", async () => {
    const old = encrypt("old-key");
    const next = encrypt("rotated-key");
    const conn = makeConnection({
      credentialsJson: { secretsEncrypted: { api_key: old } },
    });
    expect(
      await resolveSecretsForDelivery({
        connection: conn,
        templateConfig: {},
        adapterContext: "legacy-template",
      }),
    ).toEqual({ api_key: old });

    (conn.credentialsJson as { secretsEncrypted: Record<string, string> })
      .secretsEncrypted.api_key = next;

    expect(
      await resolveSecretsForDelivery({
        connection: conn,
        templateConfig: {},
        adapterContext: "legacy-template",
      }),
    ).toEqual({ api_key: next });
  });

  // ── Test 4 — Missing secrets on an active connection → loud throw ───────
  it("(4a) active connection with empty secretsEncrypted → throws CONNECTION_SECRET_MISSING", async () => {
    const conn = makeConnection({
      credentialsJson: { secretsEncrypted: {} },
    });
    let err: unknown;
    try {
      await resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        templateId: 42,
        adapterContext: "dynamic-template",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectionSecretMissingError);
    const e = err as ConnectionSecretMissingError;
    expect(e.code).toBe("CONNECTION_SECRET_MISSING");
    expect(e.connectionId).toBe(777);
    expect(e.templateId).toBe(42);
  });

  it("(4b) active connection with NO credentialsJson at all → throws", async () => {
    const conn = makeConnection({ credentialsJson: null });
    await expect(
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: {},
        adapterContext: "legacy-template",
      }),
    ).rejects.toThrow(ConnectionSecretMissingError);
  });

  it("(4c) active connection MUST NOT silently fall back to templateConfig.secrets", async () => {
    // If the user has a legacy destination with plain-text secrets
    // AND they later add a broken connection, the connection takes
    // precedence and we refuse to silently use the stale copy.
    const conn = makeConnection({ credentialsJson: {} });
    const legacyCipher = encrypt("stale-credential");
    await expect(
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: legacyCipher } },
        adapterContext: "dynamic-template",
      }),
    ).rejects.toThrow(/CONNECTION_SECRET_MISSING/);
  });

  // ── Test 5 — Non-active connection treated as "no connection" → hard throw
  it("(5a) connection status=expired → throws ConnectionRequiredError (must reconnect)", async () => {
    const conn = makeConnection({
      status: "expired",
      credentialsJson: { secretsEncrypted: {} },
    });
    await expect(
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: encrypt("ignored") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("(5b) connection status=revoked → throws ConnectionRequiredError", async () => {
    const conn = makeConnection({ status: "revoked" });
    await expect(
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: encrypt("ignored") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  // ── authType: 'none' — auth-less affiliate short-circuit ──────────────────
  // Some Uzbek affiliates accept leads without any credentials. For those
  // templates the runtime must skip the connection-vs-config decision
  // entirely: no secrets, no throw, no fallback read.

  it("(6a) authless appKey short-circuits to {} with no connection", async () => {
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: null,
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
      db: makeAuthlessDb("open_affiliate"),
    });
    expect(out).toEqual({});
  });

  it("(6b) authless appKey → ignores connection entirely (no CONNECTION_SECRET_MISSING)", async () => {
    // Even if someone mistakenly linked an empty connection to an
    // authless template, the resolver must NOT throw. The validator has
    // already guaranteed no {{SECRET:…}} tokens reach this point.
    const conn = makeConnection({ credentialsJson: {} });
    const out = await resolveSecretsForDelivery({
      connection: conn,
      templateConfig: null,
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
      db: makeAuthlessDb("open_affiliate"),
    });
    expect(out).toEqual({});
  });

  it("(6c) authless appKey → does not leak templateConfig.secrets either", async () => {
    // Defence in depth: if a stray `templateConfig.secrets` map survives
    // from a past misconfiguration, an authless resolve must still
    // return an empty object instead of shipping stale ciphertext.
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: encrypt("leftover") } },
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
      db: makeAuthlessDb("open_affiliate"),
    });
    expect(out).toEqual({});
  });

  it("(6d) unknown appKey → no short-circuit, no connection → throws ConnectionRequiredError", async () => {
    // An unknown appKey is a configuration error the validator catches
    // at save-time. The resolver treats it as if no appKey was provided —
    // and with no active connection, connection is required.
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("ignored") } },
        adapterContext: "legacy-template",
        appKey: "this-app-does-not-exist",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });
});

// ─── Integration with builder functions ─────────────────────────────────────
describe("Stage 2 — buildCustomBody / buildHeaders secretsOverride", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "stage-2-unit-test-key-do-not-use-in-prod";
  });
  afterAll(() => {
    if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  const varCtx = buildVariableContext(sampleLead, { offer_id: "42" });

  // ── Test 1 — no override, cfg.secrets still works (legacy-compat) ───────
  it("(body/legacy) secretsOverride omitted → falls back to cfg.secrets", () => {
    const cipher = encrypt("legacy-api-key");
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [
        { key: "api_key", value: "{{SECRET:api_key}}" },
        { key: "offer_id", value: "{{offer_id}}" },
      ],
      secrets: { api_key: cipher },
    };
    const { body } = buildCustomBody(cfg, varCtx);
    const params = new URLSearchParams(body as string);
    expect(params.get("api_key")).toBe("legacy-api-key");
    expect(params.get("offer_id")).toBe("42");
  });

  // ── Test 2 — override wins over cfg.secrets ─────────────────────────────
  it("(body/override) secretsOverride present → takes precedence over cfg.secrets", () => {
    const cipherLegacy = encrypt("legacy-will-be-ignored");
    const cipherFromConn = encrypt("from-connection");
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}" }],
      secrets: { api_key: cipherLegacy },
    };
    const { body } = buildCustomBody(cfg, varCtx, {
      api_key: cipherFromConn,
    });
    const params = new URLSearchParams(body as string);
    expect(params.get("api_key")).toBe("from-connection");
  });

  it("(headers/override) secretsOverride drives header resolution", () => {
    const cipherLegacy = encrypt("legacy-header");
    const cipherFromConn = encrypt("connection-header");
    const cfg = {
      headers: { Authorization: "Bearer {{SECRET:api_key}}" },
      secrets: { api_key: cipherLegacy },
    };
    const headers = buildHeaders(cfg, varCtx, "application/json", {
      api_key: cipherFromConn,
    });
    expect(headers["Authorization"]).toBe("Bearer connection-header");
  });

  // ── Test 3 — empty-string-mirror removed when connection path used ──────
  it("(body/empty-override) empty override object → SECRET becomes empty string (soft miss)", () => {
    // This is the EXISTING soft-miss contract (matches injectVariables'
    // {{unknown}} behaviour). Stage 2's strict validation happens one
    // level up in `resolveSecretsForDelivery`, not in the builder.
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}" }],
      secrets: { api_key: encrypt("will-be-ignored") },
    };
    const { body } = buildCustomBody(cfg, varCtx, {});
    const params = new URLSearchParams(body as string);
    expect(params.get("api_key")).toBe("");
  });

  // ── Test 4 — JSON template body path also honours override ──────────────
  it("(body/json-template/override) override flows into JSON bodyTemplate", () => {
    const cipherFromConn = encrypt("json-from-conn");
    const cfg = {
      contentType: "json",
      bodyTemplate: '{"api_key":"{{SECRET:api_key}}","name":"{{name}}"}',
    };
    const { body, contentTypeHeader } = buildCustomBody(cfg, varCtx, {
      api_key: cipherFromConn,
    });
    expect(contentTypeHeader).toBe("application/json");
    expect(body).toEqual({ api_key: "json-from-conn", name: "Ali Valiyev" });
  });

  // ── Test 5 — no empty-string is silently sent on broken connection ──────
  it("(e2e) broken ciphertext in override → DeliveryBlockedError (loud fail)", () => {
    // End-to-end: the override carries a bad ciphertext. The resolver
    // upgrades it to DeliveryBlockedError before any axios call is
    // made, preventing the "empty api_key was sent → partner rejected →
    // logged SENT" silent-data-loss bug from Stage D v1.
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}" }],
    };
    expect(() =>
      buildCustomBody(cfg, varCtx, { api_key: "not-a-valid-ciphertext" }),
    ).toThrow(/DELIVERY_BLOCKED_SECRET_ERROR/);
  });
});

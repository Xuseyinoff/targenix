/**
 * Stage 2 — Runtime connection-based secret resolution.
 *
 * These tests cover the exact 5 scenarios mandated by the Stage 2
 * task brief, plus supporting checks for the public helper
 * `resolveSecretsForDelivery`:
 *
 *   1. Old destination (no connection) → `templateConfig.secrets`
 *      still flows through and the request is built normally.
 *   2. New destination with an active connection → the
 *      `connections.credentialsJson.secretsEncrypted` map becomes
 *      the authoritative source.
 *   3. Connection rotation → mutating the connection's secrets map
 *      is reflected on the next resolve call (no stale copy).
 *   4. Missing secret → a connection that was explicitly linked but
 *      contains no secrets throws `ConnectionSecretMissingError` and
 *      no outbound request is built.
 *   5. No empty-string fallback when the connection is broken —
 *      delivery MUST fail loud.
 *
 * We exercise these at two layers:
 *   - The pure `resolveSecretsForDelivery` function (picking the right
 *     secrets source + strict error).
 *   - The thin `buildCustomBody` / `buildHeaders` integration path,
 *     which receives the map via the Stage 2 `secretsOverride`
 *     parameter so that connection-driven secrets reach the wire.
 *
 * No axios call is ever made — these are byte-level assertions on the
 * body / headers produced by the delivery builder, so they run in
 * milliseconds and need no DB or network stubs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ConnectionSecretMissingError,
  buildCustomBody,
  buildHeaders,
  buildVariableContext,
  resolveSecretsForDelivery,
} from "./services/affiliateService";
import { encrypt } from "./encryption";
import type { Connection } from "../drizzle/schema";

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

describe("Stage 2 — resolveSecretsForDelivery", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "stage-2-unit-test-key-do-not-use-in-prod";
  });
  afterAll(() => {
    if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  // ── Test 1 — Old destination (no connection) → fallback ─────────────────
  it("(1) no connection → returns templateConfig.secrets verbatim", () => {
    const cipher = encrypt("legacy-plain");
    const cfg = { secrets: { api_key: cipher, offer_id: "static_value" } };
    const out = resolveSecretsForDelivery({
      connection: null,
      templateConfig: cfg,
      adapterContext: "legacy-template",
    });
    expect(out).toEqual({ api_key: cipher, offer_id: "static_value" });
  });

  it("(1b) no connection AND no templateConfig.secrets → empty map", () => {
    const out = resolveSecretsForDelivery({
      connection: null,
      templateConfig: {},
      adapterContext: "legacy-template",
    });
    expect(out).toEqual({});
  });

  it("(1c) connection=undefined (not just null) still falls back", () => {
    const cipher = encrypt("legacy-plain-2");
    const out = resolveSecretsForDelivery({
      templateConfig: { secrets: { api_key: cipher } },
      adapterContext: "legacy-template",
    });
    expect(out).toEqual({ api_key: cipher });
  });

  // ── Test 2 — New destination with connection → connection wins ──────────
  it("(2) active connection with secrets → returns connection's map", () => {
    const cipherConn = encrypt("from-connection");
    const cipherLegacy = encrypt("from-legacy");
    const out = resolveSecretsForDelivery({
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
  it("(3) mutating the connection's secrets is reflected immediately", () => {
    const old = encrypt("old-key");
    const next = encrypt("rotated-key");
    const conn = makeConnection({
      credentialsJson: { secretsEncrypted: { api_key: old } },
    });
    expect(
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: {},
        adapterContext: "legacy-template",
      }),
    ).toEqual({ api_key: old });

    (conn.credentialsJson as { secretsEncrypted: Record<string, string> })
      .secretsEncrypted.api_key = next;

    expect(
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: {},
        adapterContext: "legacy-template",
      }),
    ).toEqual({ api_key: next });
  });

  // ── Test 4 — Missing secrets on an active connection → loud throw ───────
  it("(4a) active connection with empty secretsEncrypted → throws CONNECTION_SECRET_MISSING", () => {
    const conn = makeConnection({
      credentialsJson: { secretsEncrypted: {} },
    });
    try {
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        templateId: 42,
        adapterContext: "dynamic-template",
      });
      throw new Error("expected ConnectionSecretMissingError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionSecretMissingError);
      const e = err as ConnectionSecretMissingError;
      expect(e.code).toBe("CONNECTION_SECRET_MISSING");
      expect(e.connectionId).toBe(777);
      expect(e.templateId).toBe(42);
    }
  });

  it("(4b) active connection with NO credentialsJson at all → throws", () => {
    const conn = makeConnection({ credentialsJson: null });
    expect(() =>
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: {},
        adapterContext: "legacy-template",
      }),
    ).toThrow(ConnectionSecretMissingError);
  });

  it("(4c) active connection MUST NOT silently fall back to templateConfig.secrets", () => {
    // If the user has a legacy destination with plain-text secrets
    // AND they later add a broken connection, the connection takes
    // precedence and we refuse to silently use the stale copy.
    const conn = makeConnection({ credentialsJson: {} });
    const legacyCipher = encrypt("stale-credential");
    expect(() =>
      resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: legacyCipher } },
        adapterContext: "dynamic-template",
      }),
    ).toThrow(/CONNECTION_SECRET_MISSING/);
  });

  // ── Test 5 — Non-active connection is treated as "no connection" ────────
  it("(5a) connection status=expired → soft fallback to templateConfig", () => {
    // An expired OAuth token or revoked api_key should NOT hard-fail
    // existing deliveries that still have legacy secrets available.
    // This is how we keep backward compatibility while users re-auth.
    const conn = makeConnection({
      status: "expired",
      credentialsJson: { secretsEncrypted: {} },
    });
    const cipher = encrypt("legacy-fallback");
    const out = resolveSecretsForDelivery({
      connection: conn,
      templateConfig: { secrets: { api_key: cipher } },
      adapterContext: "legacy-template",
    });
    expect(out).toEqual({ api_key: cipher });
  });

  it("(5b) connection status=revoked → soft fallback, not a hard throw", () => {
    const conn = makeConnection({ status: "revoked" });
    const out = resolveSecretsForDelivery({
      connection: conn,
      templateConfig: { secrets: { api_key: encrypt("ok") } },
      adapterContext: "legacy-template",
    });
    expect(out.api_key).toBeDefined();
  });

  // ── authType: 'none' — auth-less affiliate short-circuit ──────────────────
  // Some Uzbek affiliates accept leads without any credentials. For those
  // templates the runtime must skip the connection-vs-config decision
  // entirely: no secrets, no throw, no fallback read.

  it("(6a) authless appKey → short-circuits to {} with no connection", () => {
    const out = resolveSecretsForDelivery({
      connection: null,
      templateConfig: null,
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
    });
    expect(out).toEqual({});
  });

  it("(6b) authless appKey → ignores connection entirely (no CONNECTION_SECRET_MISSING)", () => {
    // Even if someone mistakenly linked an empty connection to an
    // authless template, the resolver must NOT throw. The validator has
    // already guaranteed no {{SECRET:…}} tokens reach this point.
    const conn = makeConnection({ credentialsJson: {} });
    const out = resolveSecretsForDelivery({
      connection: conn,
      templateConfig: null,
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
    });
    expect(out).toEqual({});
  });

  it("(6c) authless appKey → does not leak templateConfig.secrets either", () => {
    // Defence in depth: if a stray `templateConfig.secrets` map survives
    // from a past misconfiguration, an authless resolve must still
    // return an empty object instead of shipping stale ciphertext.
    const out = resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: encrypt("leftover") } },
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
    });
    expect(out).toEqual({});
  });

  it("(6d) unknown appKey → no short-circuit, behaves like appKey=null", () => {
    // An unknown appKey is a configuration error the validator catches
    // at save-time. The resolver treats it as if no appKey was provided
    // so existing fallback semantics still apply.
    const out = resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: encrypt("ok") } },
      adapterContext: "legacy-template",
      appKey: "this-app-does-not-exist",
    });
    expect(out.api_key).toBeDefined();
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

/**
 * Stage 3 — Connection-only secret model.
 *
 * These tests pin the runtime contract of the
 * `USE_CONNECTION_SECRETS_ONLY` feature flag at the boundary that
 * production actually hits: `resolveSecretsForDelivery`. The flag is
 * driven by env vars so each scenario explicitly flips them and
 * resets the feature-flag cache, matching how a Railway operator
 * would roll it out.
 *
 * Scenario coverage (all four Stage 3 mandates):
 *   • Flag OFF — legacy destinations with `templateConfig.secrets` but
 *     no connection keep delivering (byte-for-byte pre-Stage-3 path).
 *   • Flag ON  — same destination fails loudly with
 *     `ConnectionRequiredError` before any HTTP work happens.
 *   • Active connection present — flag is irrelevant, the connection's
 *     secrets win and rotation is instant.
 *   • Authless spec — flag is irrelevant, resolver short-circuits to
 *     `{}` regardless of connection / legacy secrets / flag state.
 *
 * Plus two regression guards:
 *   • Flag ON + unknown userId (no tenant context available) must still
 *     fall back to legacy — the flag's conservative default for callers
 *     the resolver cannot identify.
 *   • `ConnectionSecretMissingError` (Stage 2) takes precedence over
 *     `ConnectionRequiredError` when a connection IS linked but empty,
 *     so the user sees the more actionable error.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from "vitest";
import {
  ConnectionRequiredError,
  ConnectionSecretMissingError,
  resolveSecretsForDelivery,
} from "./services/affiliateService";
import { __resetFeatureFlagsCache } from "./services/featureFlags";
import { encrypt } from "./encryption";
import type { Connection } from "../drizzle/schema";
import type { DbClient } from "./db";

/**
 * Build a minimal Drizzle-ish DbClient that returns a single authless `apps`
 * row for the given appKey. Used by authless tests to supply the spec that
 * `resolveSpecSafe` needs now that the TS constant was removed (Step C).
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

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  const base: Connection = {
    id: 7001,
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

/** Snapshot + restore the flag-related env vars so tests are order-independent. */
const ENV_KEYS = [
  "USE_CONNECTION_SECRETS_ONLY",
  "USE_CONNECTION_SECRETS_ONLY_ALL",
  "USE_CONNECTION_SECRETS_ONLY_USER_IDS",
  "ENCRYPTION_KEY",
] as const;

describe("Stage 3 — resolveSecretsForDelivery under USE_CONNECTION_SECRETS_ONLY", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ENCRYPTION_KEY = "stage-3-unit-test-key-do-not-use-in-prod";
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetFeatureFlagsCache();
  });

  beforeEach(() => {
    delete process.env.USE_CONNECTION_SECRETS_ONLY;
    delete process.env.USE_CONNECTION_SECRETS_ONLY_ALL;
    delete process.env.USE_CONNECTION_SECRETS_ONLY_USER_IDS;
    __resetFeatureFlagsCache();
  });

  // ── Flag OFF (default) ───────────────────────────────────────────────────
  it("flag OFF: no connection + legacy secrets → returns legacy secrets", async () => {
    const cipher = encrypt("legacy-key");
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: cipher } },
      adapterContext: "legacy-template",
      userId: 1,
    });
    expect(out).toEqual({ api_key: cipher });
  });

  it("flag OFF: no connection + no legacy secrets → empty map (pre-Stage-3 behaviour)", async () => {
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: {},
      adapterContext: "legacy-template",
      userId: 1,
    });
    expect(out).toEqual({});
  });

  // ── Flag ON globally (Phase 4 switch) ────────────────────────────────────
  it("flag ON (ALL=true): no connection → throws CONNECTION_REQUIRED", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        templateId: 42,
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("flag ON via bare USE_CONNECTION_SECRETS_ONLY alias also works", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY = "true";
    __resetFeatureFlagsCache();

    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("x") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("flag ON: error carries templateId + userId for operator triage", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    let err: unknown;
    try {
      await resolveSecretsForDelivery({
        connection: null,
        templateConfig: {},
        templateId: 99,
        adapterContext: "dynamic-template",
        userId: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectionRequiredError);
    const e = err as ConnectionRequiredError;
    expect(e.code).toBe("CONNECTION_REQUIRED");
    expect(e.templateId).toBe(99);
    expect(e.userId).toBe(1);
  });

  // ── Per-user allowlist (staged rollout) ──────────────────────────────────
  it("flag ON for user 1 only: user 2 still gets legacy fallback", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_USER_IDS = "1";
    __resetFeatureFlagsCache();

    // User 1 is on the allowlist → strict.
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("k1") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);

    // User 2 is NOT → legacy path still works.
    const cipher = encrypt("k2");
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: cipher } },
      adapterContext: "legacy-template",
      userId: 2,
    });
    expect(out).toEqual({ api_key: cipher });
  });

  // ── Active connection wins regardless of flag ────────────────────────────
  it("flag ON but active connection linked → uses connection, no throw", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    const fromConn = encrypt("from-connection");
    const out = await resolveSecretsForDelivery({
      connection: makeConnection({
        credentialsJson: { secretsEncrypted: { api_key: fromConn } },
      }),
      templateConfig: { secrets: { api_key: encrypt("stale-legacy") } },
      adapterContext: "legacy-template",
      userId: 1,
    });
    expect(out).toEqual({ api_key: fromConn });
  });

  it("flag ON: credential rotation on the connection propagates immediately", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    const old = encrypt("old-key");
    const conn = makeConnection({
      credentialsJson: { secretsEncrypted: { api_key: old } },
    });

    const first = await resolveSecretsForDelivery({
      connection: conn,
      templateConfig: {},
      adapterContext: "legacy-template",
      userId: 1,
    });
    expect(first.api_key).toBe(old);

    const next = encrypt("rotated-key");
    (conn.credentialsJson as { secretsEncrypted: Record<string, string> })
      .secretsEncrypted.api_key = next;

    const second = await resolveSecretsForDelivery({
      connection: conn,
      templateConfig: {},
      adapterContext: "legacy-template",
      userId: 1,
    });
    expect(second.api_key).toBe(next);
  });

  // ── Authless spec immune to the flag ─────────────────────────────────────
  it("flag ON + authless appKey → still short-circuits to {} (no throw)", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: encrypt("ignored") } },
      adapterContext: "dynamic-template",
      appKey: "open_affiliate",
      db: makeAuthlessDb("open_affiliate"),
      userId: 1,
    });
    expect(out).toEqual({});
  });

  // ── Precedence: CONN_MISSING still preferred over CONN_REQUIRED ──────────
  it("flag ON + linked-but-empty connection → throws CONNECTION_SECRET_MISSING (not CONNECTION_REQUIRED)", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    const conn = makeConnection({ credentialsJson: { secretsEncrypted: {} } });
    let err: unknown;
    try {
      await resolveSecretsForDelivery({
        connection: conn,
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        templateId: 5,
        adapterContext: "dynamic-template",
        userId: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectionSecretMissingError);
    expect(err).not.toBeInstanceOf(ConnectionRequiredError);
  });

  // ── Conservative default for unknown tenants ─────────────────────────────
  it("flag ON but userId missing → falls back (conservative, never mass-break)", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    const cipher = encrypt("fallback");
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: cipher } },
      adapterContext: "legacy-template",
      // userId omitted on purpose.
    });
    expect(out).toEqual({ api_key: cipher });
  });

  // ── Rollback behaviour ───────────────────────────────────────────────────
  it("flipping flag OFF instantly restores legacy path (rollback safety)", async () => {
    process.env.USE_CONNECTION_SECRETS_ONLY_ALL = "true";
    __resetFeatureFlagsCache();

    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("leg") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);

    delete process.env.USE_CONNECTION_SECRETS_ONLY_ALL;
    __resetFeatureFlagsCache();

    const cipher = encrypt("leg2");
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: { secrets: { api_key: cipher } },
      adapterContext: "legacy-template",
      userId: 1,
    });
    expect(out).toEqual({ api_key: cipher });
  });
});

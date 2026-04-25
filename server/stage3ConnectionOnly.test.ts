/**
 * Connection-only secret model — permanent contract tests.
 *
 * `resolveSecretsForDelivery` always requires an active connection.
 * These tests verify the four invariants that must hold unconditionally
 * in production:
 *
 *   1. No connection → throws ConnectionRequiredError (never falls back
 *      to templateConfig.secrets, regardless of whether secrets are present).
 *   2. Active connection with secrets → returns those secrets.
 *   3. Active connection with NO secrets → throws ConnectionSecretMissingError
 *      (distinct from ConnectionRequiredError so the UI can show the right action).
 *   4. Auth-less appKey → short-circuits to {} with no error, no connection needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ConnectionRequiredError,
  ConnectionSecretMissingError,
  resolveSecretsForDelivery,
} from "./services/affiliateService";
import { encrypt } from "./encryption";
import type { Connection } from "../drizzle/schema";
import type { DbClient } from "./db";

function makeAuthlessDb(appKey: string): DbClient {
  const row = {
    id: 1,
    appKey,
    displayName: appKey,
    authType: "none",
    isActive: true,
    oauthConfig: null,
    credentialFields: null,
    userVisibleFields: null,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([row]),
          then: (resolve: (v: unknown[]) => void) => resolve([row]),
        }),
      }),
    }),
  };
  return db as unknown as DbClient;
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  const base: Connection = {
    id: 1,
    userId: 1,
    type: "api_key",
    appKey: null,
    displayName: "Test",
    status: "active",
    oauthTokenId: null,
    credentialsJson: { secretsEncrypted: { api_key: encrypt("conn-secret") } },
    lastVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}

const originalKey = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "connection-only-test-key-do-not-use";
});
afterAll(() => {
  if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
  else delete process.env.ENCRYPTION_KEY;
});

describe("resolveSecretsForDelivery — connection-only contract", () => {

  // ── 1. No connection → always throws ────────────────────────────────────
  it("no connection → throws ConnectionRequiredError", async () => {
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("legacy") } },
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("no connection, no legacy secrets → still throws ConnectionRequiredError", async () => {
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: {},
        adapterContext: "legacy-template",
        userId: 1,
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  it("error carries templateId + userId for operator triage", async () => {
    let err: unknown;
    try {
      await resolveSecretsForDelivery({
        connection: null,
        templateConfig: {},
        templateId: 99,
        adapterContext: "dynamic-template",
        userId: 42,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectionRequiredError);
    const e = err as ConnectionRequiredError;
    expect(e.code).toBe("CONNECTION_REQUIRED");
    expect(e.templateId).toBe(99);
    expect(e.userId).toBe(42);
  });

  it("no connection, missing userId → still throws (upstream bug, not a pass)", async () => {
    await expect(
      resolveSecretsForDelivery({
        connection: null,
        templateConfig: { secrets: { api_key: encrypt("ignored") } },
        adapterContext: "legacy-template",
        // userId deliberately omitted
      }),
    ).rejects.toThrow(ConnectionRequiredError);
  });

  // ── 2. Active connection → wins ──────────────────────────────────────────
  it("active connection with secrets → returns connection's map", async () => {
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

  it("credential rotation on the connection propagates immediately", async () => {
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

  // ── 3. Connection present but empty → ConnectionSecretMissingError ───────
  it("linked-but-empty connection → throws CONNECTION_SECRET_MISSING, not CONNECTION_REQUIRED", async () => {
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

  // ── 4. Auth-less spec → short-circuits to {} regardless ─────────────────
  it("authless appKey → short-circuits to {} without requiring a connection", async () => {
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

  it("authless appKey + no userId → still short-circuits to {}", async () => {
    const out = await resolveSecretsForDelivery({
      connection: null,
      templateConfig: {},
      adapterContext: "dynamic-template",
      appKey: "no_auth_app",
      db: makeAuthlessDb("no_auth_app"),
    });
    expect(out).toEqual({});
  });
});

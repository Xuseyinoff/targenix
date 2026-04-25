/**
 * getValidAccessToken — unit tests
 *
 * Covers:
 *   1. Valid (non-expired) token → returned from DB without any refresh
 *   2. Google token expired → refreshed via static provider (registry)
 *   3. Generic provider token expired → refreshed via DB-driven provider
 *   4. TOKEN_NOT_FOUND → throws
 *   5. PROVIDER_NOT_FOUND → throws (appKey not in registry or DB)
 *   6. NO_REFRESH_TOKEN → throws
 *   7. invalid_grant on refresh → connection marked expired, error re-thrown
 *   8. 401 on refresh → connection marked expired, error re-thrown
 *   9. Concurrent refresh → deduplicated (only one HTTP call)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { encrypt } from "../encryption";

// ── Module mocks ──────────────────────────────────────────────────────────────

// resolveProvider is mocked so we control what the test "DB" returns.
vi.mock("./resolveProvider", () => ({
  resolveProvider: vi.fn(),
}));

// markOAuthConnectionExpired is mocked to capture calls without DB.
vi.mock("../services/connectionService", () => ({
  markOAuthConnectionExpired: vi.fn().mockResolvedValue(undefined),
  markGoogleSheetsConnectionsExpiredForOauthToken: vi.fn().mockResolvedValue(undefined),
}));

// incOAuthErrors is a simple counter — mock so we can assert it was called.
vi.mock("../monitoring/metrics", () => ({
  incOAuthErrors: vi.fn(),
}));

// log.info / log.warn — fire and forget, no need to assert.
vi.mock("../services/appLogger", () => ({
  log: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

import { getValidAccessToken } from "./getValidAccessToken";
import { resolveProvider } from "./resolveProvider";
import { markOAuthConnectionExpired } from "../services/connectionService";
import { incOAuthErrors } from "../monitoring/metrics";
import type { OAuthProviderSpec } from "./types";
import type { DbClient } from "../db";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);  // 1h ahead
const PAST = new Date(Date.now() - 60 * 60 * 1000);    // 1h ago

const ENCRYPTION_KEY_ORIG = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "getvalidaccesstoken-test-key-32ch";
  vi.clearAllMocks();
});

afterAll(() => {
  if (ENCRYPTION_KEY_ORIG !== undefined) process.env.ENCRYPTION_KEY = ENCRYPTION_KEY_ORIG;
  else delete process.env.ENCRYPTION_KEY;
});

/**
 * Build a minimal Drizzle DbClient that returns `tokenRow` from
 * `oauthTokens` SELECT and records UPDATE calls.
 */
function makeDb(tokenRow: Record<string, unknown> | null): DbClient & {
  updatedValues: Record<string, unknown> | null;
} {
  let updatedValues: Record<string, unknown> | null = null;

  return {
    get updatedValues() {
      return updatedValues;
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (tokenRow ? [tokenRow] : [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        updatedValues = vals;
        return {
          where: vi.fn(async () => {}),
        };
      }),
    })),
  } as unknown as DbClient & { updatedValues: Record<string, unknown> | null };
}

/** Build a minimal OAuthProviderSpec that refreshes with a known new token. */
function makeProvider(
  appKey: string,
  opts: { newToken?: string; throwError?: Error } = {},
): OAuthProviderSpec {
  return {
    name: appKey,
    integrationAppKey: appKey,
    getConfig: vi.fn().mockResolvedValue({}),
    buildAuthorizeUrl: vi.fn().mockReturnValue(""),
    exchangeCode: vi.fn().mockResolvedValue({}),
    refreshAccessToken: opts.throwError
      ? vi.fn().mockRejectedValue(opts.throwError)
      : vi.fn().mockResolvedValue({ accessToken: opts.newToken ?? "new-access-token", expiresIn: 3600 }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getValidAccessToken", () => {

  // ── Test 1: token still valid — no refresh ──────────────────────────────
  it("(1) non-expired token → returned immediately, no refresh", async () => {
    const plainToken = "still-valid-token";
    const db = makeDb({
      id: 1, userId: 10, appKey: "google-sheets",
      accessToken: encrypt(plainToken),
      refreshToken: encrypt("rt"),
      expiryDate: FUTURE,
    });

    const result = await getValidAccessToken(db, {
      userId: 10, appKey: "google-sheets", oauthTokenId: 1,
    });

    expect(result).toBe(plainToken);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(db.updatedValues).toBeNull();
  });

  // ── Test 2: Google token expired → refreshes via static provider ────────
  it("(2) Google expired token → refreshed via static registry provider", async () => {
    const db = makeDb({
      id: 2, userId: 10, appKey: "google-sheets",
      accessToken: encrypt("old-token"),
      refreshToken: encrypt("old-refresh-token"),
      expiryDate: PAST,
    });

    const googleProvider = makeProvider("google", { newToken: "new-google-token" });
    vi.mocked(resolveProvider).mockResolvedValue(googleProvider);

    const result = await getValidAccessToken(db, {
      userId: 10, appKey: "google-sheets", oauthTokenId: 2,
    });

    expect(result).toBe("new-google-token");
    expect(resolveProvider).toHaveBeenCalledWith("google-sheets", db);
    expect(googleProvider.refreshAccessToken).toHaveBeenCalledOnce();
    expect(db.updatedValues).toMatchObject({ accessToken: expect.any(String) });
    expect(markOAuthConnectionExpired).not.toHaveBeenCalled();
  });

  // ── Test 3: Generic provider token expired → refreshed via DB provider ──
  it("(3) Generic provider (amocrm) expired token → refreshed via DB provider", async () => {
    const db = makeDb({
      id: 3, userId: 20, appKey: "amocrm",
      accessToken: encrypt("old-amocrm-token"),
      refreshToken: encrypt("amocrm-refresh"),
      expiryDate: PAST,
    });

    const amocrmProvider = makeProvider("amocrm", { newToken: "fresh-amocrm-token" });
    vi.mocked(resolveProvider).mockResolvedValue(amocrmProvider);

    const result = await getValidAccessToken(db, {
      userId: 20, appKey: "amocrm", oauthTokenId: 3,
    });

    expect(result).toBe("fresh-amocrm-token");
    expect(resolveProvider).toHaveBeenCalledWith("amocrm", db);
    expect(amocrmProvider.refreshAccessToken).toHaveBeenCalledOnce();
    expect(db.updatedValues).toMatchObject({ accessToken: expect.any(String) });
    expect(markOAuthConnectionExpired).not.toHaveBeenCalled();
  });

  // ── Test 4: TOKEN_NOT_FOUND ─────────────────────────────────────────────
  it("(4) token row missing → throws TOKEN_NOT_FOUND", async () => {
    const db = makeDb(null);

    await expect(
      getValidAccessToken(db, { userId: 10, appKey: "google-sheets", oauthTokenId: 999 }),
    ).rejects.toThrow("TOKEN_NOT_FOUND");
  });

  // ── Test 5: PROVIDER_NOT_FOUND ──────────────────────────────────────────
  it("(5) unknown appKey → throws PROVIDER_NOT_FOUND", async () => {
    const db = makeDb({
      id: 5, userId: 10, appKey: "unknown-app",
      accessToken: encrypt("t"), refreshToken: encrypt("rt"),
      expiryDate: PAST,
    });

    vi.mocked(resolveProvider).mockResolvedValue(undefined);

    await expect(
      getValidAccessToken(db, { userId: 10, appKey: "unknown-app", oauthTokenId: 5 }),
    ).rejects.toThrow("PROVIDER_NOT_FOUND");

    expect(markOAuthConnectionExpired).not.toHaveBeenCalled();
  });

  // ── Test 6: NO_REFRESH_TOKEN ────────────────────────────────────────────
  it("(6) no refresh token stored → throws NO_REFRESH_TOKEN", async () => {
    const db = makeDb({
      id: 6, userId: 10, appKey: "google-sheets",
      accessToken: encrypt("t"), refreshToken: null,
      expiryDate: PAST,
    });

    const provider = makeProvider("google");
    vi.mocked(resolveProvider).mockResolvedValue(provider);

    await expect(
      getValidAccessToken(db, { userId: 10, appKey: "google-sheets", oauthTokenId: 6 }),
    ).rejects.toThrow("NO_REFRESH_TOKEN");

    expect(provider.refreshAccessToken).not.toHaveBeenCalled();
    expect(markOAuthConnectionExpired).not.toHaveBeenCalled();
  });

  // ── Test 7: invalid_grant → connection marked expired ───────────────────
  it("(7) invalid_grant on refresh → connection marked expired, error re-thrown", async () => {
    const db = makeDb({
      id: 7, userId: 10, appKey: "google-sheets",
      accessToken: encrypt("t"), refreshToken: encrypt("rt"),
      expiryDate: PAST,
    });

    const grantError = Object.assign(new Error("invalid_grant"), {
      response: { status: 400, data: { error: "invalid_grant" } },
    });
    const provider = makeProvider("google", { throwError: grantError });
    vi.mocked(resolveProvider).mockResolvedValue(provider);

    await expect(
      getValidAccessToken(db, { userId: 10, appKey: "google-sheets", oauthTokenId: 7 }),
    ).rejects.toThrow("invalid_grant");

    expect(markOAuthConnectionExpired).toHaveBeenCalledWith(db, 7);
    expect(incOAuthErrors).toHaveBeenCalledWith(1);
  });

  // ── Test 8: 401 on refresh → connection marked expired ──────────────────
  it("(8) 401 response on refresh → connection marked expired", async () => {
    const db = makeDb({
      id: 8, userId: 10, appKey: "amocrm",
      accessToken: encrypt("t"), refreshToken: encrypt("rt"),
      expiryDate: PAST,
    });

    const unauthorizedError = Object.assign(new Error("Request failed with status 401"), {
      response: { status: 401, data: {} },
    });
    const provider = makeProvider("amocrm", { throwError: unauthorizedError });
    vi.mocked(resolveProvider).mockResolvedValue(provider);

    await expect(
      getValidAccessToken(db, { userId: 10, appKey: "amocrm", oauthTokenId: 8 }),
    ).rejects.toThrow();

    expect(markOAuthConnectionExpired).toHaveBeenCalledWith(db, 8);
    expect(incOAuthErrors).toHaveBeenCalledWith(1);
  });

  // ── Test 9: network error (non-revoked) → NOT marked expired ────────────
  it("(9) transient network error on refresh → NOT marked expired, error re-thrown", async () => {
    const db = makeDb({
      id: 9, userId: 10, appKey: "amocrm",
      accessToken: encrypt("t"), refreshToken: encrypt("rt"),
      expiryDate: PAST,
    });

    const networkError = new Error("ECONNRESET");
    const provider = makeProvider("amocrm", { throwError: networkError });
    vi.mocked(resolveProvider).mockResolvedValue(provider);

    await expect(
      getValidAccessToken(db, { userId: 10, appKey: "amocrm", oauthTokenId: 9 }),
    ).rejects.toThrow("ECONNRESET");

    expect(markOAuthConnectionExpired).not.toHaveBeenCalled();
    expect(incOAuthErrors).toHaveBeenCalledWith(1);
  });

  // ── Test 10: concurrent refresh → single HTTP call ──────────────────────
  it("(10) concurrent refresh calls for same userId+appKey → only one HTTP request", async () => {
    const db = makeDb({
      id: 10, userId: 10, appKey: "amocrm",
      accessToken: encrypt("t"), refreshToken: encrypt("rt"),
      expiryDate: PAST,
    });

    let callCount = 0;
    const slowProvider: OAuthProviderSpec = {
      ...makeProvider("amocrm", { newToken: "deduped-token" }),
      refreshAccessToken: vi.fn(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { accessToken: "deduped-token", expiresIn: 3600 };
      }),
    };
    vi.mocked(resolveProvider).mockResolvedValue(slowProvider);

    const [r1, r2, r3] = await Promise.all([
      getValidAccessToken(db, { userId: 10, appKey: "amocrm", oauthTokenId: 10 }),
      getValidAccessToken(db, { userId: 10, appKey: "amocrm", oauthTokenId: 10 }),
      getValidAccessToken(db, { userId: 10, appKey: "amocrm", oauthTokenId: 10 }),
    ]);

    expect(r1).toBe("deduped-token");
    expect(r2).toBe("deduped-token");
    expect(r3).toBe("deduped-token");
    expect(callCount).toBe(1);
  });

});

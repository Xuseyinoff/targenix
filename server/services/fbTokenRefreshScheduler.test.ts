/**
 * fbTokenRefreshScheduler — unit tests for the per-account refresh tick.
 *
 * Match the `leadGraphRetryScheduler.test.ts` shape: mock db + the FB
 * helper via `vi.doMock`, then drive `runFbTokenRefreshTick()` and assert
 * on the returned counters plus the UPDATE calls.
 *
 * We do NOT make real FB or DB calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test sets its own mocks, so reset modules between cases. Otherwise
// the second test would import the first test's mocked module.
beforeEach(() => {
  vi.resetModules();
  process.env.FACEBOOK_APP_ID = "test-app-id";
  process.env.FACEBOOK_APP_SECRET = "test-app-secret";
  process.env.ENCRYPTION_KEY = "test-encryption-key-32chars-min-x";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FACEBOOK_APP_ID;
  delete process.env.FACEBOOK_APP_SECRET;
  delete process.env.ENCRYPTION_KEY;
  delete process.env.FB_TOKEN_REFRESH_ENABLED;
});

// ─── DB stub builder ────────────────────────────────────────────────────────
//
// The scheduler does:
//   1. db.select().from(facebookAccounts).where(...).orderBy(...) → rows
//   2. for each row: db.update(facebookAccounts).set({...}).where(...)
//
// Stub both with chainable shapes that record what gets passed in.

interface DbStub {
  rows: unknown[];
  updates: Array<{ set: Record<string, unknown> }>;
}

function makeDb(initialRows: unknown[]): DbStub {
  return { rows: initialRows, updates: [] };
}

function bindDbMocks(stub: DbStub): void {
  vi.doMock("../db", () => ({
    getDb: vi.fn().mockResolvedValue({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(stub.rows),
          }),
        }),
      }),
      update: () => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => {
            stub.updates.push({ set: payload });
            return Promise.resolve(undefined);
          },
        }),
      }),
    }),
  }));
}

// ─── Encryption — pass-through stubs ────────────────────────────────────────
//
// The scheduler decrypts the stored token (we hand it a known plaintext
// directly) and re-encrypts the fresh token. We replace both with the
// identity function so tests can assert "the new token landed in the
// UPDATE payload" without juggling AES.

function bindEncryption(): void {
  vi.doMock("../encryption", () => ({
    decrypt: (s: string) => s,
    encrypt: (s: string) => s,
  }));
}

// ─── Sample account row ─────────────────────────────────────────────────────

function makeAccount(overrides: Partial<{ id: number; userId: number; expiresInDays: number; fbUserName: string; accessToken: string }> = {}) {
  const o = overrides;
  return {
    id: o.id ?? 60001,
    userId: o.userId ?? 42,
    fbUserId: "100000000000001",
    fbUserName: o.fbUserName ?? "Test User",
    accessToken: o.accessToken ?? "old-token-plaintext",
    tokenExpiresAt: new Date(Date.now() + (o.expiresInDays ?? 10) * 24 * 60 * 60 * 1000),
    connectedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── Mocked FB error shape ──────────────────────────────────────────────────
//
// `exchangeForLongLivedToken` re-throws axios errors from the Graph
// `/oauth/access_token` endpoint. The classifier reads
// `err.response.data.error.{code, error_subcode, message}` and
// `err.response.status`. We mimic that shape so the same classification
// runs as in production.

function makeFbError(opts: {
  status?: number;
  code?: number;
  subcode?: number;
  message?: string;
}): Error {
  const err = new Error(opts.message ?? "FB error") as Error & {
    response?: { status?: number; data?: unknown };
  };
  err.response = {
    status: opts.status,
    data: {
      error: {
        message: opts.message,
        code: opts.code,
        error_subcode: opts.subcode,
      },
    },
  };
  return err;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runFbTokenRefreshTick — empty queue", () => {
  it("returns scanned=0 when no accounts are due", async () => {
    const stub = makeDb([]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi.fn(),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result).toEqual({
      scanned: 0,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      dead: 0,
    });
    expect(stub.updates).toEqual([]);
  });

  it("returns empty result when DB is unavailable", async () => {
    vi.doMock("../db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({ exchangeForLongLivedToken: vi.fn() }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.scanned).toBe(0);
    expect(result.refreshed).toBe(0);
  });

  it("returns empty result and skips work when FACEBOOK_APP_ID is missing", async () => {
    delete process.env.FACEBOOK_APP_ID;
    const stub = makeDb([makeAccount()]);
    bindDbMocks(stub);
    bindEncryption();
    const exchange = vi.fn();
    vi.doMock("./facebookGraphService", () => ({ exchangeForLongLivedToken: exchange }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.scanned).toBe(0);
    expect(exchange).not.toHaveBeenCalled();
    expect(stub.updates).toEqual([]);
  });
});

describe("runFbTokenRefreshTick — successful refresh", () => {
  it("updates accessToken + tokenExpiresAt on successful exchange", async () => {
    const stub = makeDb([makeAccount({ id: 1, accessToken: "old-token-plaintext" })]);
    bindDbMocks(stub);
    bindEncryption();
    const exchange = vi.fn().mockResolvedValue({
      access_token: "new-fresh-token",
      token_type: "bearer",
      expires_in: 60 * 24 * 60 * 60, // 60 days in seconds
    });
    vi.doMock("./facebookGraphService", () => ({ exchangeForLongLivedToken: exchange }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.refreshed).toBe(1);
    expect(result.scanned).toBe(1);
    expect(exchange).toHaveBeenCalledWith(
      "old-token-plaintext",
      "test-app-id",
      "test-app-secret",
    );
    expect(stub.updates).toHaveLength(1);
    expect(stub.updates[0]!.set.accessToken).toBe("new-fresh-token");
    expect(stub.updates[0]!.set.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("persists tokenExpiresAt=null when FB returns expires_in=0 (never-expires / business)", async () => {
    // Mirrors the bfeaf23 fix — business tokens get a 0/missing expires_in
    // and must NOT be parked at "now + 0ms".
    const stub = makeDb([makeAccount({ id: 2 })]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi.fn().mockResolvedValue({
        access_token: "never-expires-token",
        token_type: "bearer",
        expires_in: 0,
      }),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.refreshed).toBe(1);
    expect(stub.updates[0]!.set.tokenExpiresAt).toBeNull();
  });

  it("processes multiple accounts in one tick", async () => {
    const stub = makeDb([
      makeAccount({ id: 10 }),
      makeAccount({ id: 11 }),
      makeAccount({ id: 12 }),
    ]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi.fn().mockResolvedValue({
        access_token: "fresh",
        token_type: "bearer",
        expires_in: 5_184_000,
      }),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.scanned).toBe(3);
    expect(result.refreshed).toBe(3);
    expect(stub.updates).toHaveLength(3);
  });
});

describe("runFbTokenRefreshTick — error classification", () => {
  it("counts auth errors (code 190) as 'dead' and marks token expired", async () => {
    const stub = makeDb([makeAccount({ id: 20 })]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi
        .fn()
        .mockRejectedValue(makeFbError({ status: 400, code: 190, message: "Error validating access token" })),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.dead).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.refreshed).toBe(0);
    // The "dead" branch UPDATEs tokenExpiresAt to NOW so the UI surfaces it.
    expect(stub.updates).toHaveLength(1);
    expect(stub.updates[0]!.set.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("counts validation errors (code 803) as 'dead'", async () => {
    const stub = makeDb([makeAccount({ id: 21 })]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi
        .fn()
        .mockRejectedValue(makeFbError({ status: 400, code: 803, message: "Some aliases do not exist" })),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.dead).toBe(1);
    expect(stub.updates).toHaveLength(1);
  });

  it("counts permanently_missing (code 100 subcode 33) as 'dead'", async () => {
    const stub = makeDb([makeAccount({ id: 22 })]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi
        .fn()
        .mockRejectedValue(
          makeFbError({ status: 400, code: 100, subcode: 33, message: "Object does not exist" }),
        ),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.dead).toBe(1);
  });

  it("counts rate_limit (code 4) as 'skipped' — will retry tomorrow, DB unchanged", async () => {
    const stub = makeDb([makeAccount({ id: 30 })]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi
        .fn()
        .mockRejectedValue(makeFbError({ status: 429, code: 4, message: "Application request limit reached" })),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.skipped).toBe(1);
    expect(result.dead).toBe(0);
    expect(stub.updates).toEqual([]);
  });

  it("counts network errors (no FB code, 5xx) as 'skipped' — DB unchanged", async () => {
    const stub = makeDb([makeAccount({ id: 31 })]);
    bindDbMocks(stub);
    bindEncryption();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi
        .fn()
        .mockRejectedValue(makeFbError({ status: 500, message: "Internal Server Error" })),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.skipped).toBe(1);
    expect(stub.updates).toEqual([]);
  });

  it("isolates a failing account from successful ones in the same tick", async () => {
    const stub = makeDb([
      makeAccount({ id: 40, accessToken: "good-token" }),
      makeAccount({ id: 41, accessToken: "bad-token" }),
      makeAccount({ id: 42, accessToken: "another-good" }),
    ]);
    bindDbMocks(stub);
    bindEncryption();
    const exchange = vi.fn(async (token: string) => {
      if (token === "bad-token") {
        throw makeFbError({ status: 400, code: 190, message: "Dead" });
      }
      return {
        access_token: "fresh-" + token,
        token_type: "bearer",
        expires_in: 5_184_000,
      };
    });
    vi.doMock("./facebookGraphService", () => ({ exchangeForLongLivedToken: exchange }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.refreshed).toBe(2);
    expect(result.dead).toBe(1);
    expect(stub.updates).toHaveLength(3); // 2 refresh + 1 mark-expired
  });
});

describe("startFbTokenRefreshScheduler — feature flag", () => {
  it("does NOT start when FB_TOKEN_REFRESH_ENABLED is unset", async () => {
    delete process.env.FB_TOKEN_REFRESH_ENABLED;
    const { startFbTokenRefreshScheduler, _resetFbTokenRefreshState } = await import(
      "./fbTokenRefreshScheduler"
    );
    _resetFbTokenRefreshState();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startFbTokenRefreshScheduler();
    // No boot-delay setTimeout should have been queued from the scheduler.
    // Other code might call setTimeout independently — assert specifically
    // that no call used our 10-minute boot delay.
    const matchedCall = setTimeoutSpy.mock.calls.find((c) => c[1] === 10 * 60 * 1000);
    expect(matchedCall).toBeUndefined();
  });

  it("does start when FB_TOKEN_REFRESH_ENABLED=true (and is idempotent)", async () => {
    process.env.FB_TOKEN_REFRESH_ENABLED = "true";
    const { startFbTokenRefreshScheduler, stopFbTokenRefreshScheduler, _resetFbTokenRefreshState } =
      await import("./fbTokenRefreshScheduler");
    _resetFbTokenRefreshState();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    startFbTokenRefreshScheduler();
    startFbTokenRefreshScheduler(); // idempotent — second call must not queue another timer

    const bootCalls = setTimeoutSpy.mock.calls.filter((c) => c[1] === 10 * 60 * 1000);
    expect(bootCalls).toHaveLength(1);

    // Cleanup so the timer doesn't keep the test process alive.
    stopFbTokenRefreshScheduler();
  });
});

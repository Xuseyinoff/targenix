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
  // Default notifier mocks — every existing test indirectly exercises the
  // dead-path Telegram path; without these stubs the scheduler would try
  // to open a real Redis connection and timeout under `pnpm test`.
  // Per-test overrides re-register the mocks via vi.doMock to capture
  // assertion-relevant spies (see Phase 2B `notifyTokenDead` tests).
  bindNotifierMocks();
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
// The scheduler has TWO select paths plus one update path:
//   1. db.select().from(facebookAccounts).where(...).orderBy(...)   → work-queue rows
//   2. db.select({...}).from(users).where(...).limit(1)              → notifier user lookup
//   3. db.update(facebookAccounts).set({...}).where(...)             → refresh / mark-dead
//
// The stub returns the facebookAccounts work-queue from .orderBy() and the
// user row from .limit() — the calling code already knows which table it
// asked for, so we keep the dispatch simple by serving both shapes from
// the same `.where()` object.

interface DbStub {
  rows: unknown[];
  /** User row returned by the notifier's .limit(1) lookup. null/empty = no chat linked. */
  userRow: { telegramChatId: string | null } | null;
  updates: Array<{ set: Record<string, unknown> }>;
}

function makeDb(initialRows: unknown[], userRow: { telegramChatId: string | null } | null = null): DbStub {
  return { rows: initialRows, userRow, updates: [] };
}

function bindDbMocks(stub: DbStub): void {
  vi.doMock("../db", () => ({
    getDb: vi.fn().mockResolvedValue({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(stub.rows),
            limit: () => Promise.resolve(stub.userRow ? [stub.userRow] : []),
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

// ─── Redis + Telegram mocks ─────────────────────────────────────────────────
//
// Every Phase 2A-era test now indirectly exercises the Phase 2B notifier
// (the dead-path tests call `notifyTokenDead`, which uses Redis + Telegram).
// We pin both to safe defaults so existing tests don't trip; per-test
// overrides go through `vi.hoisted` + reassigning the spies via the same
// import.

interface NotifierMocks {
  redisSet: ReturnType<typeof vi.fn>;
  redisDel: ReturnType<typeof vi.fn>;
  telegramSend: ReturnType<typeof vi.fn>;
}

function bindNotifierMocks(): NotifierMocks {
  const redisSet = vi.fn(async () => "OK" as string | null);
  const redisDel = vi.fn(async () => 1);
  const telegramSend = vi.fn(async () => true);
  vi.doMock("../queues/redisConnection", () => ({
    getRedisConnection: () => ({ set: redisSet, del: redisDel }),
  }));
  vi.doMock("../webhooks/telegramWebhook", () => ({
    sendTelegramMessage: telegramSend,
  }));
  return { redisSet, redisDel, telegramSend };
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

// ─── Phase 2B — Telegram notification on dead tokens ────────────────────────

describe("notifyTokenDead — Telegram alert path", () => {
  it("sends to the user's system chat when chatId is set", async () => {
    const stub = makeDb([], { telegramChatId: "555111" });
    bindDbMocks(stub);
    const m = bindNotifierMocks();

    const { notifyTokenDead } = await import("./fbTokenRefreshScheduler");
    await notifyTokenDead({
      userId: 42,
      fbAccountId: 60001,
      fbUserName: "Test User",
      errorType: "auth",
      errorMessage: "Error validating access token",
    });

    expect(m.telegramSend).toHaveBeenCalledTimes(1);
    expect(m.telegramSend.mock.calls[0]![0]).toBe("555111");
    // Must use HTML parse mode so the <b> / <a> tags render correctly.
    expect(m.telegramSend.mock.calls[0]![2]).toBe("HTML");
  });

  it("skips silently when the user has no system Telegram chat", async () => {
    const stub = makeDb([], { telegramChatId: null });
    bindDbMocks(stub);
    const m = bindNotifierMocks();

    const { notifyTokenDead } = await import("./fbTokenRefreshScheduler");
    await notifyTokenDead({
      userId: 42,
      fbAccountId: 60001,
      fbUserName: "Test User",
      errorType: "auth",
      errorMessage: "Error",
    });

    expect(m.telegramSend).not.toHaveBeenCalled();
  });

  it("skips silently when the chatId is whitespace-only", async () => {
    const stub = makeDb([], { telegramChatId: "   " });
    bindDbMocks(stub);
    const m = bindNotifierMocks();

    const { notifyTokenDead } = await import("./fbTokenRefreshScheduler");
    await notifyTokenDead({
      userId: 42,
      fbAccountId: 60001,
      fbUserName: "Test",
      errorType: "auth",
      errorMessage: "X",
    });

    expect(m.telegramSend).not.toHaveBeenCalled();
  });
});

describe("notifyTokenDead — Redis throttle", () => {
  it("claims the slot with SET … EX 86400 NX on first call", async () => {
    const stub = makeDb([], { telegramChatId: "555111" });
    bindDbMocks(stub);
    const m = bindNotifierMocks();

    const { notifyTokenDead } = await import("./fbTokenRefreshScheduler");
    await notifyTokenDead({
      userId: 42,
      fbAccountId: 60001,
      fbUserName: "Test",
      errorType: "auth",
      errorMessage: "X",
    });

    expect(m.redisSet).toHaveBeenCalledTimes(1);
    const args = m.redisSet.mock.calls[0]!;
    expect(args[0]).toBe("fb-token-refresh-fail:42:60001");
    expect(args).toContain("EX");
    expect(args).toContain(86400);
    expect(args).toContain("NX");
  });

  it("skips Telegram when the throttle key already exists (within 24h cooldown)", async () => {
    const stub = makeDb([], { telegramChatId: "555111" });
    bindDbMocks(stub);
    const m = bindNotifierMocks();
    m.redisSet.mockResolvedValueOnce(null); // existing key — NX fails

    const { notifyTokenDead } = await import("./fbTokenRefreshScheduler");
    await notifyTokenDead({
      userId: 42,
      fbAccountId: 60001,
      fbUserName: "Test",
      errorType: "auth",
      errorMessage: "X",
    });

    expect(m.redisSet).toHaveBeenCalledTimes(1);
    expect(m.telegramSend).not.toHaveBeenCalled();
  });

  it("fails OPEN when Redis throws — sends the Telegram anyway", async () => {
    const stub = makeDb([], { telegramChatId: "555111" });
    bindDbMocks(stub);
    const m = bindNotifierMocks();
    m.redisSet.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { notifyTokenDead } = await import("./fbTokenRefreshScheduler");
    await notifyTokenDead({
      userId: 42,
      fbAccountId: 60001,
      fbUserName: "Test",
      errorType: "auth",
      errorMessage: "X",
    });

    expect(m.telegramSend).toHaveBeenCalledTimes(1);
  });
});

describe("recovery — successful refresh clears the throttle key", () => {
  it("calls redis.del on the (userId, fbAccountId) throttle key after a successful refresh", async () => {
    const stub = makeDb([
      {
        id: 7777,
        userId: 9999,
        fbUserId: "fb-9999",
        fbUserName: "Recovered User",
        accessToken: "old-token",
        tokenExpiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        connectedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    bindDbMocks(stub);
    bindEncryption();
    const m = bindNotifierMocks();
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi.fn().mockResolvedValue({
        access_token: "fresh-token",
        token_type: "bearer",
        expires_in: 5_184_000,
      }),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    const result = await runFbTokenRefreshTick();

    expect(result.refreshed).toBe(1);
    // Wait a tick — the throttle clear is `void`'d (fire-and-forget), so
    // it may complete one microtask after refreshOneAccount returns.
    await new Promise((r) => setTimeout(r, 10));
    expect(m.redisDel).toHaveBeenCalledTimes(1);
    expect(m.redisDel.mock.calls[0]![0]).toBe("fb-token-refresh-fail:9999:7777");
  });

  it("silently swallows Redis-down during throttle clear (best-effort recovery)", async () => {
    const stub = makeDb([
      {
        id: 8888,
        userId: 1234,
        fbUserId: "fb-1234",
        fbUserName: "User",
        accessToken: "old",
        tokenExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        connectedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    bindDbMocks(stub);
    bindEncryption();
    const m = bindNotifierMocks();
    m.redisDel.mockRejectedValueOnce(new Error("Redis is down"));
    vi.doMock("./facebookGraphService", () => ({
      exchangeForLongLivedToken: vi.fn().mockResolvedValue({
        access_token: "fresh",
        token_type: "bearer",
        expires_in: 5_184_000,
      }),
    }));

    const { runFbTokenRefreshTick } = await import("./fbTokenRefreshScheduler");
    // Must not throw — best-effort recovery means a Redis outage during
    // throttle clear cannot break the refresh.
    await expect(runFbTokenRefreshTick()).resolves.toMatchObject({ refreshed: 1 });
  });
});

describe("formatTokenDeadMessage — Uzbek templates", () => {
  it("auth template includes the Reconnect CTA + /connections link", async () => {
    const { formatTokenDeadMessage } = await import("./fbTokenRefreshScheduler");
    process.env.APP_URL = "https://example.com";
    const msg = formatTokenDeadMessage({
      fbUserName: "Test User",
      errorType: "auth",
      errorMessage: "Error validating access token",
    });
    expect(msg).toContain("Facebook tokeningiz tugadi");
    expect(msg).toContain("Test User");
    expect(msg).toContain('href="https://example.com/connections"');
    expect(msg).toContain("Reconnect");
    delete process.env.APP_URL;
  });

  it("permanently_missing uses the same template as auth (both → user must Reconnect)", async () => {
    const { formatTokenDeadMessage } = await import("./fbTokenRefreshScheduler");
    const msgAuth = formatTokenDeadMessage({
      fbUserName: "X",
      errorType: "auth",
      errorMessage: "Y",
    });
    const msgPerm = formatTokenDeadMessage({
      fbUserName: "X",
      errorType: "permanently_missing",
      errorMessage: "Y",
    });
    expect(msgAuth).toEqual(msgPerm);
  });

  it("validation uses a different template and quotes the FB error verbatim", async () => {
    const { formatTokenDeadMessage } = await import("./fbTokenRefreshScheduler");
    const msg = formatTokenDeadMessage({
      fbUserName: "Test",
      errorType: "validation",
      errorMessage: "Some of the aliases you requested do not exist",
    });
    expect(msg).toContain("yangilashda xato");
    expect(msg).toContain("Some of the aliases you requested do not exist");
    expect(msg).not.toContain("Reconnect");
  });

  it("escapes HTML characters in fbUserName", async () => {
    const { formatTokenDeadMessage } = await import("./fbTokenRefreshScheduler");
    const msg = formatTokenDeadMessage({
      fbUserName: "<script>alert(1)</script>",
      errorType: "auth",
      errorMessage: "x",
    });
    expect(msg).toContain("&lt;script&gt;");
    expect(msg).not.toContain("<script>alert(1)</script>");
  });

  it("escapes HTML characters in errorMessage (validation template)", async () => {
    const { formatTokenDeadMessage } = await import("./fbTokenRefreshScheduler");
    const msg = formatTokenDeadMessage({
      fbUserName: "User",
      errorType: "validation",
      errorMessage: "<b>bold</b> & < > chars",
    });
    expect(msg).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(msg).toContain("&amp;");
  });

  it("falls back to 'Facebook' when fbUserName is empty", async () => {
    const { formatTokenDeadMessage } = await import("./fbTokenRefreshScheduler");
    const msg = formatTokenDeadMessage({
      fbUserName: "",
      errorType: "auth",
      errorMessage: "x",
    });
    expect(msg).toContain("Facebook");
  });
});

describe("fbTokenRefreshFailKey — key shape", () => {
  it("namespaces by user + fbAccount", async () => {
    const { fbTokenRefreshFailKey } = await import("./fbTokenRefreshScheduler");
    expect(fbTokenRefreshFailKey(42, 60001)).toBe("fb-token-refresh-fail:42:60001");
    expect(fbTokenRefreshFailKey(99, 60001)).toBe("fb-token-refresh-fail:99:60001");
    expect(fbTokenRefreshFailKey(42, 60002)).toBe("fb-token-refresh-fail:42:60002");
  });
});

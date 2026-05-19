/**
 * leadErrorNotifier — unit tests for classification, throttling, and dispatch.
 *
 * We stub Redis, the DB user lookup, and the Telegram send so no network
 * calls happen. The notifier's contract is: silent unless errorType is
 * actionable OR this is final exhaustion; respect a 1h Redis cooldown per
 * (userId, errorType); fail open on Redis errors; require the user's
 * `telegramChatId` (system chat) to actually send.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── vi.hoisted state for mocks ────────────────────────────────────────────
//
// `vi.mock` factories are hoisted above all imports, so the factory cannot
// reference top-level `const` declarations. We use `vi.hoisted` to declare
// the mock state alongside the hoisted factory — both run before any of
// the regular module body.

const mocks = vi.hoisted(() => {
  return {
    telegramSpy: vi.fn(async () => true),
    redisSetSpy: vi.fn<[...unknown[]], Promise<string | null>>(async () => "OK"),
    redisDelSpy: vi.fn(async () => 1),
    userQueryQueue: [] as Array<{ telegramChatId: string | null }[]>,
  };
});

vi.mock("../webhooks/telegramWebhook", () => ({
  sendTelegramMessage: mocks.telegramSpy,
}));

vi.mock("../queues/redisConnection", () => ({
  getRedisConnection: () => ({
    set: mocks.redisSetSpy,
    del: mocks.redisDelSpy,
  }),
}));

vi.mock("../db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            mocks.userQueryQueue.shift() ?? [{ telegramChatId: "555111" }],
        }),
      }),
    }),
  }),
}));

import {
  classifyForNotification,
  clearLeadErrorNotifyCooldown,
  leadErrorNotifyKey,
  sendLeadErrorTelegramNotification,
} from "./leadErrorNotifier";

// ─── classifyForNotification ────────────────────────────────────────────────

describe("classifyForNotification", () => {
  it("returns 'auth' for auth + non-final", () => {
    expect(classifyForNotification("auth", false)).toBe("auth");
  });

  it("returns 'validation' for validation + non-final", () => {
    expect(classifyForNotification("validation", false)).toBe("validation");
  });

  it("returns 'silent' for permanently_missing + non-final (FB deleted the lead, user can't act)", () => {
    expect(classifyForNotification("permanently_missing", false)).toBe("silent");
  });

  it("returns 'silent' for rate_limit + non-final (transient, scheduler retries)", () => {
    expect(classifyForNotification("rate_limit", false)).toBe("silent");
  });

  it("returns 'silent' for network + non-final (transient, scheduler retries)", () => {
    expect(classifyForNotification("network", false)).toBe("silent");
  });

  it("returns 'final-exhaustion' for ANY errorType when isFinalExhaustion=true", () => {
    expect(classifyForNotification("auth", true)).toBe("final-exhaustion");
    expect(classifyForNotification("validation", true)).toBe("final-exhaustion");
    expect(classifyForNotification("permanently_missing", true)).toBe("final-exhaustion");
    expect(classifyForNotification("rate_limit", true)).toBe("final-exhaustion");
    expect(classifyForNotification("network", true)).toBe("final-exhaustion");
  });
});

// ─── leadErrorNotifyKey ─────────────────────────────────────────────────────

describe("leadErrorNotifyKey", () => {
  it("namespaces by user + errorType", () => {
    expect(leadErrorNotifyKey(42, "auth")).toBe("lead-error-notify:42:auth");
    expect(leadErrorNotifyKey(42, "validation")).toBe("lead-error-notify:42:validation");
    expect(leadErrorNotifyKey(99, "auth")).toBe("lead-error-notify:99:auth");
  });

  it("isolates different users (cross-tenant guard at the key layer)", () => {
    expect(leadErrorNotifyKey(1, "auth")).not.toBe(leadErrorNotifyKey(2, "auth"));
  });
});

// ─── sendLeadErrorTelegramNotification ──────────────────────────────────────

const BASE_PARAMS = {
  leadId: 1234,
  userId: 42,
  pageId: "111",
  pageName: "Test Page",
  formId: "222",
  formName: "Test Form",
  leadgenId: "leadgen-1",
  errorType: "auth" as const,
  dataError: "Error validating access token",
  attempts: 1,
  maxAttempts: 3,
  isFinalExhaustion: false,
};

describe("sendLeadErrorTelegramNotification — silent categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSetSpy.mockImplementation(async () => "OK");
    mocks.userQueryQueue.length = 0;
  });

  it("never calls Telegram for permanently_missing (non-final)", async () => {
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "permanently_missing" });
    expect(mocks.telegramSpy).not.toHaveBeenCalled();
    expect(mocks.redisSetSpy).not.toHaveBeenCalled();
  });

  it("never calls Telegram for network errors (non-final)", async () => {
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "network" });
    expect(mocks.telegramSpy).not.toHaveBeenCalled();
  });

  it("never calls Telegram for rate_limit (non-final)", async () => {
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "rate_limit" });
    expect(mocks.telegramSpy).not.toHaveBeenCalled();
  });
});

describe("sendLeadErrorTelegramNotification — throttle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userQueryQueue.length = 0;
  });

  it("sends when Redis SET NX returns OK (slot won)", async () => {
    mocks.redisSetSpy.mockResolvedValueOnce("OK");
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    expect(mocks.redisSetSpy).toHaveBeenCalledTimes(1);
    expect(mocks.telegramSpy).toHaveBeenCalledTimes(1);
  });

  it("skips when Redis SET NX returns null (existing cooldown blocks)", async () => {
    mocks.redisSetSpy.mockResolvedValueOnce(null);
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    expect(mocks.redisSetSpy).toHaveBeenCalledTimes(1);
    expect(mocks.telegramSpy).not.toHaveBeenCalled();
  });

  it("uses an EX of 3600 seconds (1h cooldown)", async () => {
    mocks.redisSetSpy.mockResolvedValueOnce("OK");
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    const args = mocks.redisSetSpy.mock.calls[0]!;
    expect(args).toContain("EX");
    expect(args).toContain(3600);
    expect(args).toContain("NX");
  });

  it("final-exhaustion bypasses cooldown entirely (no SET NX call)", async () => {
    await sendLeadErrorTelegramNotification({
      ...BASE_PARAMS,
      errorType: "network",
      isFinalExhaustion: true,
      attempts: 3,
    });
    expect(mocks.redisSetSpy).not.toHaveBeenCalled();
    expect(mocks.telegramSpy).toHaveBeenCalledTimes(1);
  });

  it("fails OPEN when Redis throws — better duplicate than silent loss", async () => {
    mocks.redisSetSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    expect(mocks.telegramSpy).toHaveBeenCalledTimes(1);
  });
});

describe("sendLeadErrorTelegramNotification — user lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSetSpy.mockImplementation(async () => "OK");
    mocks.userQueryQueue.length = 0;
  });

  it("skips when user has no telegramChatId (system chat not linked)", async () => {
    mocks.userQueryQueue.push([{ telegramChatId: null }]);
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    expect(mocks.telegramSpy).not.toHaveBeenCalled();
  });

  it("skips when user has empty/whitespace telegramChatId", async () => {
    mocks.userQueryQueue.push([{ telegramChatId: "   " }]);
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    expect(mocks.telegramSpy).not.toHaveBeenCalled();
  });

  it("sends to the user's system chat (NOT a destination's delivery chat)", async () => {
    mocks.userQueryQueue.push([{ telegramChatId: "777999" }]);
    await sendLeadErrorTelegramNotification({ ...BASE_PARAMS, errorType: "auth" });
    expect(mocks.telegramSpy).toHaveBeenCalledTimes(1);
    expect(mocks.telegramSpy.mock.calls[0]![0]).toBe("777999");
  });
});

describe("clearLeadErrorNotifyCooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DELs both auth + validation keys for the user", async () => {
    await clearLeadErrorNotifyCooldown(42);
    expect(mocks.redisDelSpy).toHaveBeenCalledTimes(2);
    const calledKeys = mocks.redisDelSpy.mock.calls.map((c) => c[0]);
    expect(calledKeys).toContain("lead-error-notify:42:auth");
    expect(calledKeys).toContain("lead-error-notify:42:validation");
  });

  it("never throws when Redis is down — cooldown just expires naturally", async () => {
    mocks.redisDelSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(clearLeadErrorNotifyCooldown(42)).resolves.toBeUndefined();
  });
});

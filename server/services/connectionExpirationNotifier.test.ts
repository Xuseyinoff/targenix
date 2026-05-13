/**
 * connectionExpirationNotifier — unit tests for cooldown, dispatch routing,
 * and audit-row recording. We stub the external SMTP + Telegram bindings
 * so no real network calls happen in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../webhooks/telegramWebhook", () => ({
  sendTelegramMessage: vi.fn(async () => true),
}));

const sendMailSpy = vi.fn(async () => undefined);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailSpy })),
  },
}));

import { notifyConnectionExpired } from "./connectionExpirationNotifier";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";
import type { DbClient } from "../db";

// ─── Minimal chainable DB stub ──────────────────────────────────────────────
//
// notifyConnectionExpired performs three reads in sequence:
//   1. SELECT latest notification_sent event for cooldown
//   2. SELECT connection
//   3. SELECT user
// followed by ONE write:
//   4. INSERT notification_sent event row
//
// We model each step as a queue entry on `selectResults`; the insert is
// observed via the `inserts` array.

interface DbStubOpts {
  selectResults: unknown[][];
  inserts: unknown[];
}

function makeDb(opts: DbStubOpts): DbClient {
  const queue = [...opts.selectResults];

  const selectChain = () => {
    const result = queue.shift() ?? [];
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(result)),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(result)),
          })),
        })),
      })),
    };
  };

  const db = {
    select: vi.fn(selectChain),
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        opts.inserts.push(row);
        return Promise.resolve([{ insertId: opts.inserts.length }]);
      }),
    })),
  } as unknown as DbClient;

  return db;
}

const CONNECTION_ROW = {
  id: 101,
  userId: 42,
  displayName: "My Google Account",
  type: "google_sheets",
  appKey: "google_sheets",
  status: "expired",
};

const USER_ROW = {
  id: 42,
  name: "Alice",
  email: "alice@example.com",
  telegramChatId: "555111",
};

describe("notifyConnectionExpired — cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASS = "pass";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("skips dispatch when a recent notification_sent row exists within cooldown", async () => {
    const inserts: unknown[] = [];
    const recentEvent = [{ createdAt: new Date(Date.now() - 1000) }]; // 1s ago
    const db = makeDb({
      selectResults: [recentEvent],
      inserts,
    });

    await notifyConnectionExpired(db, {
      connectionId: 101,
      userId: 42,
      reason: "oauth_refresh_failed",
    });

    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("dispatches when no prior notification_sent row exists", async () => {
    const inserts: unknown[] = [];
    const db = makeDb({
      selectResults: [
        [], // no prior notification
        [CONNECTION_ROW], // connection lookup
        [USER_ROW], // user lookup
      ],
      inserts,
    });

    await notifyConnectionExpired(db, {
      connectionId: 101,
      userId: 42,
      reason: "oauth_refresh_failed",
    });

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });

  it("dispatches when prior notification is older than cooldown", async () => {
    const inserts: unknown[] = [];
    const oldEvent = [{ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }];
    const db = makeDb({
      selectResults: [
        oldEvent,
        [CONNECTION_ROW],
        [USER_ROW],
      ],
      inserts,
    });

    await notifyConnectionExpired(db, {
      connectionId: 101,
      userId: 42,
    });

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });

  it("respects a custom cooldown override (for tests / ops)", async () => {
    const inserts: unknown[] = [];
    const recent = [{ createdAt: new Date(Date.now() - 30 * 1000) }];
    const db = makeDb({
      selectResults: [
        recent,
        [CONNECTION_ROW],
        [USER_ROW],
      ],
      inserts,
    });

    await notifyConnectionExpired(db, {
      connectionId: 101,
      userId: 42,
      cooldownMs: 10 * 1000, // 10s — older than 30s, so should dispatch
    });

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });
});

describe("notifyConnectionExpired — dispatch routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASS = "pass";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("skips email when SMTP is not configured but still sends Telegram", async () => {
    delete process.env.SMTP_HOST;
    const inserts: unknown[] = [];
    const db = makeDb({
      selectResults: [[], [CONNECTION_ROW], [USER_ROW]],
      inserts,
    });

    await notifyConnectionExpired(db, { connectionId: 101, userId: 42 });

    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as { details: { channels: { email: string; telegram: string } } };
    expect(row.details.channels.email).toBe("disabled");
    expect(row.details.channels.telegram).toBe("sent");
  });

  it("skips Telegram when user has no chatId but still sends email", async () => {
    const inserts: unknown[] = [];
    const userNoTelegram = { ...USER_ROW, telegramChatId: null };
    const db = makeDb({
      selectResults: [[], [CONNECTION_ROW], [userNoTelegram]],
      inserts,
    });

    await notifyConnectionExpired(db, { connectionId: 101, userId: 42 });

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    const row = inserts[0] as { details: { channels: { email: string; telegram: string } } };
    expect(row.details.channels.email).toBe("sent");
    expect(row.details.channels.telegram).toBe("skipped_no_chat");
  });

  it("skips email when user has no address", async () => {
    const inserts: unknown[] = [];
    const userNoEmail = { ...USER_ROW, email: null };
    const db = makeDb({
      selectResults: [[], [CONNECTION_ROW], [userNoEmail]],
      inserts,
    });

    await notifyConnectionExpired(db, { connectionId: 101, userId: 42 });

    expect(sendMailSpy).not.toHaveBeenCalled();
    const row = inserts[0] as { details: { channels: { email: string; telegram: string } } };
    expect(row.details.channels.email).toBe("skipped_no_address");
  });

  it("records failure when Telegram send returns false", async () => {
    vi.mocked(sendTelegramMessage).mockResolvedValueOnce(false);
    const inserts: unknown[] = [];
    const db = makeDb({
      selectResults: [[], [CONNECTION_ROW], [USER_ROW]],
      inserts,
    });

    await notifyConnectionExpired(db, { connectionId: 101, userId: 42 });

    const row = inserts[0] as { details: { channels: { telegram: string } } };
    expect(row.details.channels.telegram).toBe("failed");
  });

  it("records failure when SMTP throws", async () => {
    sendMailSpy.mockRejectedValueOnce(new Error("relay refused"));
    const inserts: unknown[] = [];
    const db = makeDb({
      selectResults: [[], [CONNECTION_ROW], [USER_ROW]],
      inserts,
    });

    await notifyConnectionExpired(db, { connectionId: 101, userId: 42 });

    const row = inserts[0] as { details: { channels: { email: string } } };
    expect(row.details.channels.email).toBe("failed");
  });
});

describe("notifyConnectionExpired — safety guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASS = "pass";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("returns silently when connection row is missing", async () => {
    const inserts: unknown[] = [];
    const db = makeDb({
      selectResults: [[], [], [USER_ROW]],
      inserts,
    });

    await expect(
      notifyConnectionExpired(db, { connectionId: 999, userId: 42 }),
    ).resolves.toBeUndefined();
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("returns silently when connection belongs to a different user (cross-tenant guard)", async () => {
    const inserts: unknown[] = [];
    const foreignConnection = { ...CONNECTION_ROW, userId: 999 };
    const db = makeDb({
      selectResults: [[], [foreignConnection], [USER_ROW]],
      inserts,
    });

    await notifyConnectionExpired(db, { connectionId: 101, userId: 42 });

    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("never throws — DB error during cooldown read is swallowed", async () => {
    const inserts: unknown[] = [];
    const explodingDb = {
      select: vi.fn(() => {
        throw new Error("connection refused");
      }),
      insert: vi.fn(() => ({ values: vi.fn() })),
    } as unknown as DbClient;

    await expect(
      notifyConnectionExpired(explodingDb, { connectionId: 101, userId: 42 }),
    ).resolves.toBeUndefined();
    expect(inserts).toHaveLength(0);
  });
});

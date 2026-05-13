/**
 * connectionExpirationNotifier — fires a best-effort user notification
 * when a connection transitions to status = "expired".
 *
 * Three detection paths exist today (OAuth refresh failure, manual marking
 * after refresh failure, and the periodic health-check sweep) and all of
 * them funnel through `appendConnectionEvent`. We hook in there so a single
 * trigger covers every path uniformly.
 *
 * Channels: email (nodemailer) + system Telegram bot. Both run in
 * `Promise.allSettled` so one failing channel never starves the other.
 *
 * Cooldown: a refresh that has already failed once will keep failing every
 * time the scheduler probes it, so without a cooldown the user would get
 * the same email every 10 minutes. We use `connection_events` itself as
 * the cooldown ledger — querying for the latest `notification_sent` row
 * for the connection and skipping if it's within DEFAULT_COOLDOWN_MS.
 *
 * Inserts the `notification_sent` audit row even when both channels fail,
 * so the next scheduler tick doesn't retry the same dead address minutes
 * later. The user can manually retry by reconnecting (which clears the
 * cooldown by virtue of the new "active" transition not blocking anything).
 */

import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../db";
import { connectionEvents, connections, users } from "../../drizzle/schema";
import { log } from "./appLogger";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export interface NotifyConnectionExpiredParams {
  connectionId: number;
  userId: number;
  /** Free-form short reason for logs + email body, e.g. "oauth_refresh_failed". */
  reason?: string;
  /** Override the cooldown (mostly for tests). */
  cooldownMs?: number;
}

interface DispatchOutcome {
  email: "sent" | "skipped_no_address" | "failed" | "disabled";
  telegram: "sent" | "skipped_no_chat" | "failed" | "disabled";
}

/**
 * Fire-and-forget. Never throws — failures are logged. Callers should
 * `void`-discard the promise.
 */
export async function notifyConnectionExpired(
  db: DbClient,
  params: NotifyConnectionExpiredParams,
): Promise<void> {
  const cooldownMs = params.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  try {
    if (await isWithinCooldown(db, params.connectionId, cooldownMs)) {
      return;
    }

    const [connection] = await db
      .select({
        id: connections.id,
        userId: connections.userId,
        displayName: connections.displayName,
        type: connections.type,
        appKey: connections.appKey,
        status: connections.status,
      })
      .from(connections)
      .where(eq(connections.id, params.connectionId))
      .limit(1);

    if (!connection) return;
    if (connection.userId !== params.userId) return;

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        telegramChatId: users.telegramChatId,
      })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);

    if (!user) return;

    const message = buildMessage({
      connectionName: connection.displayName,
      connectionType: connection.appKey ?? connection.type,
      reason: params.reason ?? null,
    });

    const outcome = await dispatch({
      to: { email: user.email, telegramChatId: user.telegramChatId },
      subject: message.subject,
      emailHtml: message.html,
      emailText: message.text,
      telegramText: message.telegramText,
    });

    await recordNotificationSent(db, {
      connectionId: connection.id,
      userId: user.id,
      outcome,
      reason: params.reason ?? null,
    });
  } catch (err) {
    void log.error(
      "CONNECTIONS",
      "notifyConnectionExpired threw — notification not delivered",
      {
        connectionId: params.connectionId,
        userId: params.userId,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      null,
      params.userId,
    );
  }
}

async function isWithinCooldown(
  db: DbClient,
  connectionId: number,
  cooldownMs: number,
): Promise<boolean> {
  const [latest] = await db
    .select({ createdAt: connectionEvents.createdAt })
    .from(connectionEvents)
    .where(
      and(
        eq(connectionEvents.connectionId, connectionId),
        eq(connectionEvents.eventType, "notification_sent"),
      ),
    )
    .orderBy(desc(connectionEvents.createdAt))
    .limit(1);
  if (!latest) return false;
  const ageMs = Date.now() - new Date(latest.createdAt).getTime();
  return ageMs < cooldownMs;
}

async function recordNotificationSent(
  db: DbClient,
  params: {
    connectionId: number;
    userId: number;
    outcome: DispatchOutcome;
    reason: string | null;
  },
): Promise<void> {
  try {
    await db.insert(connectionEvents).values({
      connectionId: params.connectionId,
      userId: params.userId,
      eventType: "notification_sent",
      source: "system",
      details: {
        purpose: "expired",
        channels: params.outcome,
        reason: params.reason,
      },
    });
  } catch (err) {
    void log.error(
      "CONNECTIONS",
      "Failed to persist notification_sent audit row",
      {
        connectionId: params.connectionId,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      null,
      params.userId,
    );
  }
}

function buildMessage(args: {
  connectionName: string;
  connectionType: string;
  reason: string | null;
}): { subject: string; html: string; text: string; telegramText: string } {
  const connectionsUrl = `${APP_URL}/connections`;
  const subject = `Connection expired: ${args.connectionName}`;

  const text =
    `Your ${args.connectionType} connection "${args.connectionName}" has expired and is no longer delivering leads.\n\n` +
    `Reconnect it to resume delivery: ${connectionsUrl}\n\n` +
    `Lead delivery to destinations using this connection is paused until reconnected.`;

  const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f9fafb;border-radius:12px">
        <h2 style="margin:0 0 8px;font-size:20px;color:#111">Connection expired</h2>
        <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.6">
          Your <strong>${escapeHtml(args.connectionType)}</strong> connection
          "<strong>${escapeHtml(args.connectionName)}</strong>" has expired and is
          no longer delivering leads.
        </p>
        <a href="${connectionsUrl}"
           style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">
          Reconnect
        </a>
        <p style="margin:24px 0 0;color:#999;font-size:12px">
          Lead delivery to destinations using this connection is paused until reconnected.
        </p>
      </div>
    `;

  const telegramText =
    `⚠️ <b>Connection expired</b>\n\n` +
    `Your <b>${escapeHtml(args.connectionType)}</b> connection ` +
    `"<b>${escapeHtml(args.connectionName)}</b>" has expired.\n\n` +
    `Reconnect to resume lead delivery:\n${connectionsUrl}`;

  return { subject, html, text, telegramText };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function dispatch(args: {
  to: { email: string | null; telegramChatId: string | null };
  subject: string;
  emailHtml: string;
  emailText: string;
  telegramText: string;
}): Promise<DispatchOutcome> {
  const [emailResult, telegramResult] = await Promise.allSettled([
    sendEmail(args.to.email, args.subject, args.emailHtml, args.emailText),
    sendTelegram(args.to.telegramChatId, args.telegramText),
  ]);

  return {
    email: emailResult.status === "fulfilled" ? emailResult.value : "failed",
    telegram: telegramResult.status === "fulfilled" ? telegramResult.value : "failed",
  };
}

async function sendEmail(
  to: string | null,
  subject: string,
  html: string,
  text: string,
): Promise<DispatchOutcome["email"]> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return "disabled";
  }
  if (!to) return "skipped_no_address";

  const { default: nodemailer } = await import("nodemailer");
  const port = parseInt(process.env.SMTP_PORT ?? "587");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  });
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@targenix.uz";

  try {
    await transporter.sendMail({
      from: `"Targenix.uz" <${from}>`,
      to,
      subject,
      text,
      html,
    });
    return "sent";
  } catch (err) {
    void log.error(
      "CONNECTIONS",
      "expiration email send failed",
      { to, error: err instanceof Error ? err.message : String(err) },
    );
    return "failed";
  }
}

async function sendTelegram(
  chatId: string | null,
  text: string,
): Promise<DispatchOutcome["telegram"]> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return "disabled";
  if (!chatId) return "skipped_no_chat";
  const ok = await sendTelegramMessage(chatId, text, "HTML");
  return ok ? "sent" : "failed";
}

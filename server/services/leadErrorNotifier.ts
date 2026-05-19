/**
 * leadErrorNotifier — Telegram alerts for inbound leads whose Facebook Graph
 * enrichment failed (token expired, request shape rejected, etc.).
 *
 * Background:
 *   `processLead` already persists the failed lead with `dataStatus='ERROR'`
 *   plus a classified `dataErrorType`. Before this module the user only saw
 *   the failure when they opened /leads — there was no proactive signal. This
 *   notifier closes that gap.
 *
 * Surface:
 *   Called from `persistGraphFailure` (leadService.ts) only when an active
 *   LEAD_ROUTING integration exists for the `(userId, pageId, formId)` triple
 *   — i.e. the user actually configured Targenix to route this form. Webhook
 *   leads with no integration are still saved (audit trail) but silent.
 *
 * Channel:
 *   `users.telegramChatId` — the **system** chat the user linked via
 *   `/start <token>`. That chat is explicitly reserved for alerts/errors/stats
 *   (see telegramWebhook.ts:211). Delivery chats on destinations are for
 *   successful lead handoff, never error alerts.
 *
 * Throttling:
 *   Redis `SET … EX 3600 NX` keyed by `lead-error-notify:{userId}:{errorType}`.
 *   First writer wins, subsequent failures in the same hour are silent. The
 *   final-exhaustion category bypasses the cooldown because the user almost
 *   certainly hasn't acted yet by the time we burn through 3 retries.
 *
 *   On a successful Graph fetch (`processLead` success branch) we DEL the
 *   `auth` and `validation` keys for that user, so a fresh failure after
 *   recovery re-fires immediately instead of waiting out the leftover hour.
 *
 *   Redis-down: fail OPEN. A duplicate notification is better than silent
 *   loss of the user's actionable signal.
 */

import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { getDb } from "../db";
import { getRedisConnection } from "../queues/redisConnection";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";
import { formatLeadErrorMessage, type LeadErrorMessageCategory } from "./telegramFormatter";
import { log } from "./appLogger";
import type { GraphErrorType } from "../lib/leadEnrichmentRetryPolicy";

/** Redis key TTL — 1h quiet window per (userId, errorType). */
export const LEAD_ERROR_NOTIFY_TTL_SEC = 60 * 60;

/** What a classified error becomes from the notification side. `silent` = don't fire. */
export type NotificationCategory = LeadErrorMessageCategory | "silent";

/**
 * Decide whether (and how) to notify, given the classifier output plus
 * whether this attempt was the final one. Final exhaustion always notifies
 * (regardless of errorType) because the lead is now permanently abandoned.
 */
export function classifyForNotification(
  errorType: GraphErrorType,
  isFinalExhaustion: boolean,
): NotificationCategory {
  // Final-exhaustion takes precedence — even for normally-silent buckets we
  // want a closing "the lead is fully abandoned" message so the user has a
  // chance to manually retry from the Leads page.
  if (isFinalExhaustion) {
    return "final-exhaustion";
  }

  if (errorType === "auth") return "auth";
  if (errorType === "validation") return "validation";

  // permanently_missing → FB deleted the lead; the user can't act.
  // rate_limit / network → transient, the scheduler retries — wait for either
  // success or final-exhaustion.
  return "silent";
}

/**
 * Build the Redis throttle key. Exposed for tests.
 *
 *   `lead-error-notify:{userId}:{errorType}`
 */
export function leadErrorNotifyKey(userId: number, errorType: GraphErrorType): string {
  return `lead-error-notify:${userId}:${errorType}`;
}

/**
 * Throttle helper. Returns `true` when this caller "won" the slot (and may
 * proceed to send), `false` when an existing key blocks it.
 *
 * On any Redis error we fail OPEN (return true) — see module docstring.
 */
async function tryClaimNotifyWindow(
  userId: number,
  errorType: GraphErrorType,
): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const result = await redis.set(
      leadErrorNotifyKey(userId, errorType),
      "1",
      "EX",
      LEAD_ERROR_NOTIFY_TTL_SEC,
      "NX",
    );
    return result === "OK";
  } catch (err) {
    await log.warn(
      "LEAD",
      "[leadErrorNotifier] Redis SET NX failed — proceeding without throttle",
      { userId, errorType, error: err instanceof Error ? err.message : String(err) },
      null,
      null,
      userId,
    );
    return true;
  }
}

/**
 * Clear the auth + validation cooldown keys for a user. Called from the
 * `processLead` success branch so a recovered user gets a fresh signal if
 * a new failure follows within the leftover hour.
 *
 * `permanently_missing` / `rate_limit` / `network` keys are never written
 * (they map to "silent"), so we don't need to clear them.
 * `final-exhaustion` has no key (it bypasses the throttle entirely).
 *
 * Best-effort: Redis down → silent (the cooldown will simply expire on its
 * own in <= 1h).
 */
export async function clearLeadErrorNotifyCooldown(userId: number): Promise<void> {
  try {
    const redis = getRedisConnection();
    await Promise.all([
      redis.del(leadErrorNotifyKey(userId, "auth")),
      redis.del(leadErrorNotifyKey(userId, "validation")),
    ]);
  } catch (err) {
    // Best-effort — a stale cooldown will expire on its own within the hour,
    // so this branch never blocks lead processing. Warn instead of error so
    // a flaky Redis doesn't spam the error feed.
    await log.warn(
      "LEAD",
      "[leadErrorNotifier] Cooldown clear skipped (Redis unreachable)",
      { userId, error: err instanceof Error ? err.message : String(err) },
      null,
      null,
      userId,
    );
  }
}

export interface SendLeadErrorTelegramParams {
  leadId: number;
  userId: number;
  pageId: string;
  pageName: string | null;
  formId: string;
  formName: string | null;
  leadgenId: string | null;
  errorType: GraphErrorType;
  dataError: string | null;
  /** Completed attempts AFTER this failure was recorded (1-based). */
  attempts: number;
  /** LEAD_MAX_GRAPH_ATTEMPTS — included in the final-exhaustion template. */
  maxAttempts: number;
  /** Whether this attempt exhausted the retry budget. */
  isFinalExhaustion: boolean;
}

/**
 * Public entry point. Fire-and-forget from the caller's perspective —
 * we swallow every error so the lead-processing pipeline is never blocked
 * by a Telegram outage.
 *
 * Caller is responsible for the integration-presence check; this function
 * does NOT re-verify it (keeps the responsibility crisp).
 */
export async function sendLeadErrorTelegramNotification(
  params: SendLeadErrorTelegramParams,
): Promise<void> {
  try {
    const category = classifyForNotification(params.errorType, params.isFinalExhaustion);
    if (category === "silent") return;

    // final-exhaustion bypasses the cooldown — see module docstring.
    if (category !== "final-exhaustion") {
      const won = await tryClaimNotifyWindow(params.userId, params.errorType);
      if (!won) return;
    }

    const db = await getDb();
    if (!db) return;

    const [userRow] = await db
      .select({ telegramChatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);

    const chatId = userRow?.telegramChatId?.trim();
    if (!chatId) {
      // User never linked the system chat — we have no way to reach them.
      // Don't release the Redis slot: the message is "unsendable" right
      // now anyway, and re-trying within 1h won't help. After 1h the key
      // expires naturally and a future failure can fire if they've linked
      // their chat by then.
      return;
    }

    const message = formatLeadErrorMessage(category, {
      leadId: params.leadId,
      pageName: params.pageName,
      formName: params.formName,
      leadgenId: params.leadgenId,
      errorType: params.errorType,
      dataError: params.dataError,
      attempts: params.attempts,
      maxAttempts: params.maxAttempts,
    });

    await sendTelegramMessage(chatId, message, "HTML");
  } catch (err) {
    await log.error(
      "LEAD",
      "[leadErrorNotifier] sendLeadErrorTelegramNotification threw — notification not delivered",
      {
        leadId: params.leadId,
        userId: params.userId,
        errorType: params.errorType,
        error: err instanceof Error ? err.message : String(err),
      },
      params.leadId,
      params.pageId,
      params.userId,
    );
  }
}

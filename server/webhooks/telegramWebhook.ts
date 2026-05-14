/**
 * Telegram Bot Webhook Handler
 *
 * Minimal flow:
 * - /start <token> (private): links a Telegram user to a Targenix user (system chat)
 * - my_chat_member (group/channel): auto-discovery — the bot resolves the
 *   Telegram user who added it (`from`) back to a Targenix account and, once
 *   the bot is an administrator, links the chat as a DELIVERY chat with no
 *   copy/paste. If the adder can't be tied to an account, it falls back to
 *   posting the Chat ID for manual linking on the website.
 */

import type { Request, Response } from "express";
import { getDb } from "../db";
import { telegramChats, telegramPendingChats, users } from "../../drizzle/schema";
import { eq, or } from "drizzle-orm";
import { log } from "../services/appLogger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

// ─── Rate limiting ─────────────────────────────────────────────────────────
//
// Telegram's documented limits:
//   - Per chat: 1 message/sec sustained (bursts of 1)
//   - Per bot:  ~30 messages/sec
//   - Group chats: relaxed slightly but still ~20 msg/min for sustained
//
// Without local enforcement we hit 429 and the bot library has no built-in
// backoff — the Railway logs show "retry after 41" loops happening every
// few seconds. With these buckets we self-regulate before Telegram has to.
//
// Implementation: simple lazy token buckets keyed by chatId + a global one
// for the bot. Each send waits until both buckets have a token. On 429 we
// also respect Telegram's `retry_after` field (a one-shot retry after the
// suggested wait).

const PER_CHAT_REFILL_INTERVAL_MS = 1_000;  // 1 token/sec per chat
const GLOBAL_REFILL_INTERVAL_MS = Math.floor(1_000 / 25);  // ~25/sec global (under Telegram's 30 cap)
const MAX_RETRY_AFTER_MS = 60_000;  // hard cap: never wait > 1 minute for a single send
const MAX_429_RETRIES = 1;          // one one-shot retry; if Telegram still says no, give up

const chatBuckets = new Map<string, { availableAt: number }>();
let globalAvailableAt = 0;

async function waitForTokens(chatKey: string): Promise<void> {
  const now = Date.now();
  const chatBucket = chatBuckets.get(chatKey) ?? { availableAt: 0 };
  const chatWait = Math.max(0, chatBucket.availableAt - now);
  const globalWait = Math.max(0, globalAvailableAt - now);
  const wait = Math.max(chatWait, globalWait);

  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }

  const after = Date.now();
  chatBuckets.set(chatKey, { availableAt: after + PER_CHAT_REFILL_INTERVAL_MS });
  globalAvailableAt = after + GLOBAL_REFILL_INTERVAL_MS;

  // Naive eviction: when the map gets large, drop entries whose availableAt
  // is well in the past (no longer rate-limit-bound). Keeps memory bounded
  // when the bot talks to many chats over a long-running process.
  if (chatBuckets.size > 500) {
    const cutoff = after - 60_000;
    for (const [k, v] of Array.from(chatBuckets.entries())) {
      if (v.availableAt < cutoff) chatBuckets.delete(k);
    }
  }
}

/** Send a Telegram message via Bot API, respecting per-chat + global rate limits. */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML",
): Promise<boolean> {
  if (!BOT_TOKEN) {
    await log.warn("TELEGRAM", "TELEGRAM_BOT_TOKEN not set — skipping message", { chatId });
    return false;
  }

  const chatKey = String(chatId);
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await waitForTokens(chatKey);
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return true;

      // Telegram puts the suggested cooldown in `parameters.retry_after`
      // (seconds). We respect it once — burning a 41-sec wait beats the
      // alternative of retrying every couple of seconds and being told the
      // same thing 10 times in a row (which is what the logs were showing).
      const retryAfterSec = data.parameters?.retry_after;
      if (retryAfterSec != null && attempt < MAX_429_RETRIES) {
        const waitMs = Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
        await log.warn(
          "TELEGRAM",
          `sendMessage 429 — waiting ${Math.round(waitMs / 1000)}s before retry`,
          { chatId, retryAfterSec },
        );
        // Park BOTH buckets for the cooldown so concurrent sends don't pile on.
        const parkUntil = Date.now() + waitMs;
        chatBuckets.set(chatKey, { availableAt: parkUntil });
        globalAvailableAt = Math.max(globalAvailableAt, parkUntil);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      await log.error("TELEGRAM", `sendMessage failed: ${data.description}`, { chatId });
      return false;
    } catch (err) {
      await log.error("TELEGRAM", "sendMessage threw", { chatId, error: String(err) });
      return false;
    }
  }
  return false;
}

// Exposed for tests + ops debugging.
export function _resetTelegramBuckets(): void {
  chatBuckets.clear();
  globalAvailableAt = 0;
}

/** Register the Telegram bot webhook URL with Telegram servers */
export async function registerTelegramWebhook(appUrl: string): Promise<void> {
  if (!BOT_TOKEN) return;
  // Strip any path from APP_URL — we only need the origin (scheme + host)
  let origin = appUrl;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    /* keep as-is */
  }
  const webhookUrl = `${origin}/api/telegram/webhook`;
  const allowedUpdates = ["message", "my_chat_member"] as const;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: [...allowedUpdates],
        ...(WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {}),
      }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    await log.info("TELEGRAM", `setWebhook → ${data.ok ? "OK" : data.description}`, {
      webhookUrl,
      allowedUpdates: [...allowedUpdates],
    });
  } catch (err) {
    await log.error("TELEGRAM", "setWebhook threw", { error: String(err) });
  }
}

/** Express handler for POST /api/telegram/webhook */
export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  if (WEBHOOK_SECRET) {
    const header = req.headers["x-telegram-bot-api-secret-token"];
    if (header !== WEBHOOK_SECRET) {
      res.status(403).json({ ok: false });
      return;
    }
  }

  // Always respond 200 immediately so Telegram doesn't retry
  res.status(200).json({ ok: true });

  const update = req.body as TelegramUpdate;
  if (!update) return;

  if (update.message) {
    const message = update.message;
    const chatId = String(message.chat.id);
    const text = message.text ?? "";
    const from = message.from;

    await log.info("TELEGRAM", "Incoming message", {
      chatId,
      text: text.slice(0, 120),
      fromUsername: from?.username,
      chatType: message.chat.type,
    });

    if (text.startsWith("/start")) {
      const token = parseStartToken(text);
      if (token) {
        if (message.chat.type !== "private") {
          await sendTelegramMessage(chatId, "ℹ️ Hisobni ulash uchun botning shaxsiy chatida /start bosing.", "HTML");
          return;
        }
        await handleStartWithToken(chatId, token, from);
        return;
      }
    }

    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "👋 Salom! Targenix.uz botiga xush kelibsiz.\n\n1) <b>System chat</b> ulandi.\n\n<b>Kanal ulash</b>:\n- Botni kerakli guruh/kanalga qo‘shing\n- Botni <b>administrator</b> qiling\n- Kanal Targenix.uz hisobingizda <b>avtomatik</b> paydo bo‘ladi — hech narsa ko‘chirib yozish shart emas.",
        "HTML",
      );
      return;
    }
  }

  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member);
    return;
  }
}

function parseStartToken(text: string): string | null {
  // Supports:
  // - "/start <token>"
  // - "/start@BotName <token>"
  // Telegram may include the bot mention in groups.
  const m = text.match(/^\/start(?:@\w+)?\s+(.+)\s*$/i);
  const token = m?.[1]?.trim();
  return token ? token : null;
}

async function handleStartWithToken(chatId: string, token: string, from?: TelegramUser): Promise<void> {
  if (!token) return;
  const db = await getDb();
  if (!db) return;

  // Token replay/expiry protection (format: <random>.<expiresAtMs>)
  const parts = token.split(".");
  if (parts.length >= 2) {
    const expiresAtMs = Number(parts[parts.length - 1]);
    const expiresValid = Number.isFinite(expiresAtMs) && expiresAtMs > 0;
    if (expiresValid && Date.now() > expiresAtMs) {
      await log.warn("TELEGRAM", "Connect token expired", { token: token.slice(0, 8) + "..." });
      // Clear so it can't be reused after expiry (best-effort)
      void db.update(users).set({ telegramConnectToken: null }).where(eq(users.telegramConnectToken, token));
      await sendTelegramMessage(
        chatId,
        "❌ Token topilmadi yoki muddati o'tgan. Iltimos, Targenix.uz saytidan qaytadan urinib ko'ring.",
        "HTML",
      );
      return;
    }
  }

  const [user] = await db.select().from(users).where(eq(users.telegramConnectToken, token)).limit(1);
  if (!user) {
    await log.warn("TELEGRAM", "No user found for connect token", { token: token.slice(0, 8) + "..." });
    await sendTelegramMessage(
      chatId,
      "❌ Token topilmadi yoki muddati o'tgan. Iltimos, Targenix.uz saytidan qaytadan urinib ko'ring.",
      "HTML",
    );
    return;
  }

  await db
    .update(users)
    .set({
      telegramUserId: from?.id != null ? String(from.id) : null,
      telegramChatId: chatId,
      telegramUsername: from?.username ?? null,
      telegramConnectedAt: new Date(),
      telegramConnectToken: null,
    })
    .where(eq(users.id, user.id));

  await log.info("TELEGRAM", "User linked Telegram account", {
    userId: user.id,
    chatId,
    username: from?.username,
  });

  await sendTelegramMessage(
    chatId,
    "✅ <b>Targenix.uz ga muvaffaqiyatli ulandi!</b>\n\nBu <b>System chat</b> hisoblanadi: bu yerga faqat alert/error/statistika keladi.\n\n<b>Kanal ulash</b>: botni kerakli guruh/kanalga qo‘shing va <b>admin</b> qiling — kanal Targenix.uz hisobingizda <b>avtomatik</b> paydo bo‘ladi. Hech qanday Chat ID ko‘chirish shart emas.",
    "HTML",
  );
}

async function handleMyChatMember(evt: TelegramChatMemberUpdated): Promise<void> {
  const chatId = String(evt.chat.id);
  const newStatus = evt.new_chat_member?.status;

  // Only react in non-private chats
  if (evt.chat.type === "private") return;
  if (!newStatus) return;

  const db = await getDb();
  if (!db) return;

  const title = evt.chat.title ?? null;
  const username = (evt.chat as any)?.username ?? null;
  const chatType = evt.chat.type;
  const chatLabel = escapeHtml(evt.chat.title ?? (evt.chat as any)?.username ?? "N/A");

  // ── Resolve which Targenix account added the bot ──────────────────────────
  // The my_chat_member `from` is the Telegram user who added/promoted the bot.
  // Match it against users.telegramUserId (set on /start <token>) and, for
  // accounts connected before that column existed, users.telegramChatId — a
  // private chat's id equals the Telegram user's id, so it works as a fallback.
  let claimedByUserId: number | null = null;
  const fromId = evt.from?.id != null ? String(evt.from.id) : null;
  if (fromId) {
    try {
      const [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(or(eq(users.telegramUserId, fromId), eq(users.telegramChatId, fromId)))
        .limit(1);
      claimedByUserId = owner?.id ?? null;
    } catch (err) {
      await log.warn("TELEGRAM", "Failed to resolve chat owner", { chatId, error: String(err) });
    }
  }

  // ── Upsert the pending-chat cache; capture the previous status so we only
  //    message on real transitions (my_chat_member fires on every permission
  //    tweak). Never downgrade a known owner back to NULL.
  let prevBotStatus: string | null = null;
  try {
    const [existing] = await db
      .select({
        id: telegramPendingChats.id,
        botStatus: telegramPendingChats.botStatus,
        claimedByUserId: telegramPendingChats.claimedByUserId,
      })
      .from(telegramPendingChats)
      .where(eq(telegramPendingChats.chatId, chatId))
      .limit(1);

    if (existing) {
      prevBotStatus = existing.botStatus;
      await db
        .update(telegramPendingChats)
        .set({
          title,
          username,
          chatType,
          botStatus: newStatus,
          claimedByUserId: claimedByUserId ?? existing.claimedByUserId ?? null,
          lastSeenAt: new Date(),
        })
        .where(eq(telegramPendingChats.id, existing.id));
    } else {
      await db.insert(telegramPendingChats).values({
        chatId,
        chatType,
        title,
        username,
        botStatus: newStatus,
        claimedByUserId,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
    }
  } catch (err) {
    await log.warn("TELEGRAM", "Failed to upsert pending chat", { chatId, error: String(err) });
  }

  // If the bot was removed/left/kicked, don't message.
  if (newStatus !== "member" && newStatus !== "administrator") return;

  const statusChanged = prevBotStatus !== newStatus;

  // ── Admin: the bot can post — try to auto-link as a DELIVERY chat ─────────
  if (newStatus === "administrator") {
    if (claimedByUserId != null) {
      let alreadyOwnerId: number | null = null;
      try {
        const [already] = await db
          .select({ userId: telegramChats.userId })
          .from(telegramChats)
          .where(eq(telegramChats.chatId, chatId))
          .limit(1);
        alreadyOwnerId = already?.userId ?? null;

        if (alreadyOwnerId == null) {
          await db.insert(telegramChats).values({
            userId: claimedByUserId,
            chatId,
            type: "DELIVERY",
            title,
            username,
            connectedAt: new Date(),
            createdAt: new Date(),
          });
          await log.info("TELEGRAM", "Auto-linked delivery chat", { chatId, userId: claimedByUserId });
          await sendTelegramMessage(
            chatId,
            `✅ <b>${chatLabel}</b> kanali Targenix hisobingizga ulandi.\n\nEndi bu kanalga lead'lar avtomatik yuboriladi. Sozlamalarni <b>Targenix.uz → Settings → Telegram</b> bo‘limidan boshqarishingiz mumkin.`,
            "HTML",
          );
          return;
        }
      } catch (err) {
        // Unique-constraint race or DB error — stay quiet; the website's
        // manual "enter Chat ID" path still works.
        await log.warn("TELEGRAM", "Auto-link delivery chat failed", { chatId, error: String(err) });
      }

      if (statusChanged) {
        if (alreadyOwnerId === claimedByUserId) {
          await sendTelegramMessage(
            chatId,
            `ℹ️ <b>${chatLabel}</b> allaqachon Targenix hisobingizga ulangan.`,
            "HTML",
          );
        } else if (alreadyOwnerId != null) {
          await sendTelegramMessage(
            chatId,
            `⚠️ Bu kanal boshqa Targenix hisobiga ulangan. Agar bu xato bo‘lsa, support bilan bog‘laning.`,
            "HTML",
          );
        }
      }
      return;
    }

    // Admin, but we can't tie the adder to an account — manual fallback.
    if (statusChanged) {
      await sendTelegramMessage(
        chatId,
        `✅ Bot <b>${chatLabel}</b> da admin qilindi.\n\nAgar kanal Targenix.uz saytida avtomatik ko‘rinmasa, quyidagi Chat ID ni <b>Settings → Telegram</b> bo‘limiga kiriting:\n<b>Chat ID:</b> <code>${escapeHtml(chatId)}</code>`,
        "HTML",
      );
    }
    return;
  }

  // ── Member: added but not an admin yet — it can't post until promoted ─────
  if (!statusChanged) return;
  if (claimedByUserId != null) {
    await sendTelegramMessage(
      chatId,
      `👋 Rahmat! <b>${chatLabel}</b> ga qo‘shildim.\n\n⚠️ Lead'larni yuborishim uchun meni <b>administrator</b> qiling. Admin huquq berilishi bilan kanal Targenix hisobingizda avtomatik paydo bo‘ladi.`,
      "HTML",
    );
  } else {
    await sendTelegramMessage(
      chatId,
      `👋 Salom! Bot qo‘shildi.\n\n⚠️ Meni <b>administrator</b> qiling.\n\nAgar kanal Targenix.uz saytida avtomatik ko‘rinmasa, quyidagi Chat ID ni <b>Settings → Telegram</b> bo‘limiga kiriting:\n<b>Chat ID:</b> <code>${escapeHtml(chatId)}</code>`,
      "HTML",
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ─── Telegram Update Types ────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
  title?: string;
}

interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from?: TelegramUser;
  date: number;
  old_chat_member: { status: string };
  new_chat_member: { status: string };
}

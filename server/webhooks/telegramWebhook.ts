/**
 * Telegram Bot Webhook Handler
 *
 * Minimal flow:
 * - /start <token> (private): links a Telegram user to a Targenix user (system chat)
 * - my_chat_member (group/channel): bot posts Chat ID for copy/paste linking on the website
 *
 * Delivery chat linking is done on the website by entering chatId and verifying bot admin.
 */

import type { Request, Response } from "express";
import { getDb } from "../db";
import { telegramPendingChats, users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { log } from "../services/appLogger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

/** Send a Telegram message via Bot API */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML",
): Promise<boolean> {
  if (!BOT_TOKEN) {
    await log.warn("TELEGRAM", "TELEGRAM_BOT_TOKEN not set — skipping message", { chatId });
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      await log.error("TELEGRAM", `sendMessage failed: ${data.description}`, { chatId });
      return false;
    }
    return true;
  } catch (err) {
    await log.error("TELEGRAM", "sendMessage threw", { chatId, error: String(err) });
    return false;
  }
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
        "👋 Salom! Targenix.uz botiga xush kelibsiz.\n\n1) <b>System chat</b> ulandi.\n\n<b>Delivery chat ulash</b>:\n- Botni kerakli guruh/kanalga qo‘shing\n- Botni <b>administrator</b> qiling\n- Bot o‘sha chatning <b>Chat ID</b> sini yozib beradi\n\nKeyin Targenix.uz saytidan <b>Settings → Telegram → Delivery Chats</b> bo‘limiga kirib Chat ID ni kiriting.",
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
    "✅ <b>Targenix.uz ga muvaffaqiyatli ulandi!</b>\n\nBu <b>System chat</b> hisoblanadi: bu yerga faqat alert/error/statistika keladi.\n\nDelivery chat ulash: botni kerakli guruh/kanalga qo‘shing va <b>admin</b> qiling — bot u chatning <b>Chat ID</b> sini yozib beradi. Keyin saytda (Settings → Telegram → Delivery Chats) chatId ni kiriting.",
    "HTML",
  );
}

async function handleMyChatMember(evt: TelegramChatMemberUpdated): Promise<void> {
  const chatId = String(evt.chat.id);
  const newStatus = evt.new_chat_member?.status;

  // Only react in non-private chats
  if (evt.chat.type === "private") return;
  if (!newStatus) return;

  // Keep a best-effort pending chat cache (useful for support/debugging)
  const db = await getDb();
  if (db) {
    try {
      const title = evt.chat.title ?? null;
      const username = (evt.chat as any)?.username ?? null;
      const chatType = evt.chat.type;

      const [existing] = await db
        .select({ id: telegramPendingChats.id })
        .from(telegramPendingChats)
        .where(eq(telegramPendingChats.chatId, chatId))
        .limit(1);

      if (existing) {
        await db
          .update(telegramPendingChats)
          .set({ title, username, chatType, botStatus: newStatus, lastSeenAt: new Date() })
          .where(eq(telegramPendingChats.id, existing.id));
      } else {
        await db.insert(telegramPendingChats).values({
          chatId,
          chatType,
          title,
          username,
          botStatus: newStatus,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        });
      }
    } catch (err) {
      await log.warn("TELEGRAM", "Failed to upsert pending chat", { chatId, error: String(err) });
    }
  }

  // If bot is removed/left, don't spam.
  if (newStatus !== "member" && newStatus !== "administrator") return;

  await sendTelegramMessage(
    chatId,
    `👋 Salom! Bot qo‘shildi.\n\n<b>Chat:</b> ${escapeHtml(evt.chat.title ?? (evt.chat as any)?.username ?? "N/A")}\n<b>Chat ID:</b> <code>${escapeHtml(chatId)}</code>\n\n1) Botga <b>admin</b> huquq bering.\n2) Shu Chat ID ni copy qiling.\n3) Targenix.uz → Settings → Telegram → Delivery Chats bo‘limida Chat ID ni kiriting.`,
    "HTML",
  );
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

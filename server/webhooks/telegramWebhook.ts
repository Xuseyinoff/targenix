/**
 * Telegram Bot Webhook Handler
 *
 * Handles incoming Telegram updates from the bot.
 * Primary use case: /start <token> — links a Telegram chat to a user account.
 */

import type { Request, Response } from "express";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { log } from "../services/appLogger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

/** Send a Telegram message via Bot API */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML"
): Promise<boolean> {
  if (!BOT_TOKEN) {
    await log.warn("TELEGRAM", "TELEGRAM_BOT_TOKEN not set — skipping message", { chatId });
    return false;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
      }
    );
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
  try { origin = new URL(appUrl).origin; } catch { /* keep as-is */ }
  const webhookUrl = `${origin}/api/telegram/webhook`;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      }
    );
    const data = (await res.json()) as { ok: boolean; description?: string };
    await log.info("TELEGRAM", `setWebhook → ${data.ok ? "OK" : data.description}`, { webhookUrl });
  } catch (err) {
    await log.error("TELEGRAM", "setWebhook threw", { error: String(err) });
  }
}

/** Express handler for POST /api/telegram/webhook */
export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  // Always respond 200 immediately so Telegram doesn't retry
  res.status(200).json({ ok: true });

  const update = req.body as TelegramUpdate;
  if (!update?.message) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const text = message.text ?? "";
  const from = message.from;

  await log.info("TELEGRAM", "Incoming update", {
    chatId,
    text: text.slice(0, 100),
    fromUsername: from?.username,
  });

  // Handle /start <token>
  if (text.startsWith("/start ")) {
    const token = text.slice(7).trim();
    await handleStartWithToken(chatId, token, from);
    return;
  }

  // Handle plain /start (no token)
  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "👋 Salom! Targenix.uz botiga xush kelibsiz.\n\nHisobingizni ulash uchun <b>Targenix.uz → Settings → Telegram</b> bo'limiga o'ting va \"Connect Telegram\" tugmasini bosing.",
      "HTML"
    );
  }
}

async function handleStartWithToken(
  chatId: string,
  token: string,
  from?: TelegramUser
): Promise<void> {
  if (!token) return;

  const db = await getDb();
  if (!db) return;
  // Find user with matching connect token
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.telegramConnectToken, token))
    .limit(1);

  if (!user) {
    await log.warn("TELEGRAM", "No user found for connect token", { token: token.slice(0, 8) + "..." });
    await sendTelegramMessage(
      chatId,
      "❌ Token topilmadi yoki muddati o'tgan. Iltimos, Targenix.uz saytidan qaytadan urinib ko'ring.",
      "HTML"
    );
    return;
  }

  // Save chat_id and clear the token
  await db
    .update(users)
    .set({
      telegramChatId: chatId,
      telegramUsername: from?.username ?? null,
      telegramConnectedAt: new Date(),
      telegramConnectToken: null, // consume the token
    })
    .where(eq(users.id, user.id));

  await log.info("TELEGRAM", "User linked Telegram account", {
    userId: user.id,
    chatId,
    username: from?.username,
  });

  // Send confirmation message in Uzbek
  await sendTelegramMessage(
    chatId,
    "✅ <b>Targenix.uz ga muvaffaqiyatli ulandi!</b>\n\nEndi yangi leadlar bu yerga yuboriladi.",
    "HTML"
  );
}

// ─── Telegram Update Types ────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
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
}

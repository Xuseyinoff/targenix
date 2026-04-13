/**
 * Telegram Bot Webhook Handler
 *
 * Handles incoming Telegram updates from the bot.
 * Primary use case: /start <token> — links a Telegram chat to a user account.
 */

import type { Request, Response } from "express";
import { getDb } from "../db";
import { telegramChatConnectTokens, telegramChats, users } from "../../drizzle/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { log } from "../services/appLogger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "Targenixbot";

type BotIdentity = { id: number; username?: string };
let cachedBot: BotIdentity | null = null;

async function getBotIdentity(): Promise<BotIdentity | null> {
  if (cachedBot) return cachedBot;
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { id: number; username?: string } };
    if (!data.ok || !data.result) return null;
    cachedBot = { id: data.result.id, username: data.result.username };
    return cachedBot;
  } catch {
    return null;
  }
}

async function getChatMemberStatus(chatId: string, userId: number): Promise<string | null> {
  if (!BOT_TOKEN) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
    const res = await fetch(url);
    const data = (await res.json()) as { ok: boolean; result?: { status?: string } };
    if (!data.ok) return null;
    return data.result?.status ?? null;
  } catch {
    return null;
  }
}

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

    // Handle /start <token> and /start@BotName <token>
    if (text.startsWith("/start")) {
      const token = parseStartToken(text);
      await log.info("TELEGRAM", "Parsed /start token", {
        chatId,
        tokenFound: !!token,
        tokenPrefix: token ? token.slice(0, 8) + "..." : "N/A",
        chatType: message.chat.type,
      });
      if (token) {
        if (message.chat.type !== "private") {
          await log.info("TELEGRAM", "Routing to handleDeliveryStartWithToken", {
            chatId,
            chatType: message.chat.type,
          });
          await handleDeliveryStartWithToken(chatId, token, message.chat);
        } else {
          await log.info("TELEGRAM", "Routing to handleStartWithToken", { chatId });
          await handleStartWithToken(chatId, token, from);
        }
        return;
      }
    }

    // Handle plain /start (no token)
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "👋 Salom! Targenix.uz botiga xush kelibsiz.\n\n1) <b>System chat</b> ulandi.\n2) Leadlarni yuborish uchun: <b>Targenix.uz → Settings → Telegram → Add delivery chat</b> bo'limiga o'ting va botni guruh/kanalga qo'shib <b>Confirm</b> qiling.",
        "HTML"
      );
      return;
    }
  }

  // Bot added to group/channel — ask for confirmation (delivery chat connect)
  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member);
    return;
  }

  // Inline button callbacks: Confirm / Cancel
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
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
      telegramUserId: from?.id != null ? String(from.id) : null,
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
    "✅ <b>Targenix.uz ga muvaffaqiyatli ulandi!</b>\n\nBu <b>System chat</b> hisoblanadi: bu yerga faqat alert/error/statistika keladi.\n\nLeadlarni yuborish uchun <b>Delivery chat</b> qo'shing: Settings → Telegram → Add delivery chat.",
    "HTML"
  );
}

async function handleDeliveryStartWithToken(
  chatId: string,
  token: string,
  chat: TelegramChat,
): Promise<void> {
  if (!token) {
    await log.warn("TELEGRAM", "handleDeliveryStartWithToken: token is empty");
    return;
  }
  const db = await getDb();
  if (!db) {
    await log.error("TELEGRAM", "handleDeliveryStartWithToken: DB unavailable");
    return;
  }

  await log.info("TELEGRAM", "handleDeliveryStartWithToken: looking up token", {
    chatId,
    tokenPrefix: token.slice(0, 8) + "...",
    chatTitle: chat.title,
    chatType: chat.type,
  });

  const [tok] = await db
    .select()
    .from(telegramChatConnectTokens)
    .where(and(eq(telegramChatConnectTokens.token, token), isNull(telegramChatConnectTokens.usedAt), gt(telegramChatConnectTokens.expiresAt, new Date())))
    .limit(1);

  if (!tok) {
    await log.warn("TELEGRAM", "handleDeliveryStartWithToken: token not found or expired", {
      chatId,
      tokenPrefix: token.slice(0, 8) + "...",
    });
    await sendTelegramMessage(
      chatId,
      "❌ Token topilmadi yoki muddati o'tgan. Iltimos, Targenix.uz saytidan qaytadan \"Add delivery chat\" qiling.",
      "HTML",
    );
    return;
  }

  // If already connected, stop.
  const [existing] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
  if (existing) {
    await log.info("TELEGRAM", "handleDeliveryStartWithToken: chat already connected", {
      chatId,
      existingUserId: (existing as any)?.userId,
    });
    await sendTelegramMessage(chatId, "ℹ️ Bu chat allaqachon ulangan.", "HTML");
    return;
  }

  const title = chat.title ?? "Telegram chat";
  // Telegram inline button callback_data is max 64 bytes — never embed the raw secret token.
  const payloadConfirm = `tg:c:${tok.id}`;
  const payloadCancel = `tg:x:${tok.id}`;

  if (!BOT_TOKEN) {
    await log.error("TELEGRAM", "handleDeliveryStartWithToken: BOT_TOKEN not set");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Hello 👋\n\nDo you want to connect this chat to <b>Targenix</b>?\n\n<b>${escapeHtml(title)}</b>\n\nConfirm linking:`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Confirm", callback_data: payloadConfirm },
              { text: "❌ Cancel", callback_data: payloadCancel },
            ],
          ],
        },
      }),
    });
    await log.info("TELEGRAM", "handleDeliveryStartWithToken: confirmation buttons sent", {
      chatId,
      tokenId: tok.id,
    });
  } catch (err) {
    await log.error("TELEGRAM", "handleDeliveryStartWithToken: Failed to send confirm buttons", {
      chatId,
      error: String(err),
    });
  }
}

async function handleMyChatMember(evt: TelegramChatMemberUpdated): Promise<void> {
  const chatId = String(evt.chat.id);
  const newStatus = evt.new_chat_member?.status;

  // Only react when bot becomes a member/admin in a non-private chat
  if (evt.chat.type === "private") return;
  if (!newStatus || (newStatus !== "member" && newStatus !== "administrator")) return;

  await sendTelegramMessage(
    chatId,
    "👋 Salom! Bot guruh/kanalga qo'shildi.\n\nUlash uchun Targenix.uz saytida <b>Settings → Telegram → Add delivery chat</b> tugmasini bosing va chiqqan link orqali botni aynan shu chatga qo'shing. Shunda bot bu yerda <b>Confirm</b> tugmasini chiqaradi.",
    "HTML",
  );
}

async function handleCallbackQuery(q: TelegramCallbackQuery): Promise<void> {
  const chatId = String(q.message?.chat?.id ?? q.from?.id ?? "");
  const data = q.data ?? "";

  await log.info("TELEGRAM", "Incoming callback", {
    chatId,
    data: data.slice(0, 80),
    fromUsername: q.from?.username,
  });

  async function answer(text?: string, showAlert?: boolean) {
    if (!BOT_TOKEN || !q.id) return;
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: q.id,
          text,
          show_alert: !!showAlert,
        }),
      });
    } catch {
      // ignore
    }
  }

  if (!data.startsWith("tg:")) return;
  const parts = data.split(":");
  const action = parts[1];
  const payload = parts.slice(2).join(":").trim();
  if (!payload) return;

  const db = await getDb();
  if (!db) return;

  // New format (short): tg:c:<connectTokenRowId> / tg:x:<connectTokenRowId>
  // Legacy: tg:confirm:<token> / tg:cancel:<token>
  let tok: typeof telegramChatConnectTokens.$inferSelect | undefined;
  if (action === "x" || action === "c") {
    const id = Number(payload);
    if (!Number.isFinite(id)) return;
    const [row] = await db
      .select()
      .from(telegramChatConnectTokens)
      .where(eq(telegramChatConnectTokens.id, id))
      .limit(1);
    tok = row;
  } else if (action === "cancel" || action === "confirm") {
    const [row] = await db
      .select()
      .from(telegramChatConnectTokens)
      .where(eq(telegramChatConnectTokens.token, payload))
      .limit(1);
    tok = row;
  } else {
    return;
  }

  const isCancel = action === "cancel" || action === "x";
  const isConfirm = action === "confirm" || action === "c";

  if (isCancel) {
    if (tok) {
      await db
        .update(telegramChatConnectTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(telegramChatConnectTokens.id, tok.id),
            isNull(telegramChatConnectTokens.usedAt),
            gt(telegramChatConnectTokens.expiresAt, new Date()),
          ),
        );
    }
    await answer("Cancelled");
    await sendTelegramMessage(chatId, "❌ Cancelled.", "HTML");
    return;
  }

  if (!isConfirm) return;

  // Validate token: unexpired & unused
  if (!tok || tok.usedAt != null || !(tok.expiresAt > new Date())) {
    await log.warn("TELEGRAM", "Confirm failed: token missing/expired/used", {
      chatId,
      connectTokenId: action === "c" ? Number(payload) : undefined,
      tokenPrefix: action === "confirm" ? payload.slice(0, 8) + "..." : undefined,
    });
    await answer("Token expired. Recreate in Settings.", true);
    await sendTelegramMessage(chatId, "❌ Token topilmadi yoki muddati o'tgan. Iltimos, saytdan qaytadan urinib ko'ring.", "HTML");
    return;
  }

  // Enforce unique ownership
  const [existing] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
  if (existing) {
    await log.warn("TELEGRAM", "Confirm blocked: chat already linked", { chatId, existingUserId: (existing as any)?.userId });
    await answer("Chat already linked.", true);
    await sendTelegramMessage(chatId, "❌ Bu chat allaqachon boshqa userga ulangan (yoki avvalroq ulangan).", "HTML");
    return;
  }

  // Admin check: bot must be administrator
  const bot = await getBotIdentity();
  if (!bot) {
    await answer("Bot misconfigured.", true);
    await sendTelegramMessage(chatId, "❌ Bot konfiguratsiyasi xato: TELEGRAM_BOT_TOKEN yo'q.", "HTML");
    return;
  }
  const status = await getChatMemberStatus(chatId, bot.id);
  if (status !== "administrator") {
    await log.warn("TELEGRAM", "Confirm blocked: bot is not admin", { chatId, status });
    await answer("Bot must be admin.", true);
    await sendTelegramMessage(
      chatId,
      "❌ Bot bu chatda <b>administrator</b> emas.\n\nIltimos botga admin huquq bering va qaytadan Confirm qiling.",
      "HTML",
    );
    return;
  }

  const title = q.message?.chat?.title ?? null;
  const username = (q.message?.chat as any)?.username ?? null;

  await db.insert(telegramChats).values({
    userId: tok.userId,
    chatId,
    type: "DELIVERY",
    title,
    username,
    connectedAt: new Date(),
    createdAt: new Date(),
  });

  await db
    .update(telegramChatConnectTokens)
    .set({ usedAt: new Date() })
    .where(eq(telegramChatConnectTokens.id, tok.id));

  await sendTelegramMessage(
    chatId,
    "✅ <b>Delivery chat ulandi!</b>\n\nEndi integratsiyalarga biriktirib leadlarni shu yerga yuborishingiz mumkin (Settings → Telegram).",
    "HTML",
  );
  await answer("✅ Connected!");
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
  callback_query?: TelegramCallbackQuery;
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

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: { chat: TelegramChat };
  data?: string;
}

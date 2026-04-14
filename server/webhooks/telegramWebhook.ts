/**
 * Telegram Bot Webhook Handler
 *
 * Handles incoming Telegram updates from the bot.
 * Primary use case: /start <token> — links a Telegram chat to a user account.
 */

import type { Request, Response } from "express";
import crypto from "crypto";
import { getDb } from "../db";
import { integrations, targetWebsites, telegramChatConnectTokens, telegramChats, telegramLinkingSessionChats, telegramLinkingSessions, telegramPendingChats, users } from "../../drizzle/schema";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
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
  /** Explicit list so Telegram never sticks to a stale narrow subset (e.g. message-only → no callback_query). */
  const allowedUpdates = ["message", "callback_query", "my_chat_member"] as const;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: [...allowedUpdates] }),
      }
    );
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
          await log.info("TELEGRAM", "Routing to handlePrivateStartWithToken", { chatId });
          await handlePrivateStartWithToken(chatId, token, from);
        }
        return;
      }
    }

    // Handle plain /start (no token)
    if (text === "/start") {
      // Private chat: show onboarding actions (delivery linking is handled inside Telegram)
      if (message.chat.type === "private") {
        if (!BOT_TOKEN) return;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "👋 Salom! Targenix.uz botiga xush kelibsiz.\n\nQuyidagilardan birini tanlang:",
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ Delivery chat qo‘shish", callback_data: "tg:lsn" }],
              ],
            },
          }),
        });
      } else {
        await sendTelegramMessage(
          chatId,
          "👋 Salom! Bu botni boshqarish uchun shaxsiy chatda /start bosing.",
          "HTML",
        );
      }
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

async function handlePrivateStartWithToken(
  chatId: string,
  token: string,
  from?: TelegramUser,
): Promise<void> {
  // In private chat, the token can be:
  // 1) users.telegramConnectToken — link system chat
  // 2) telegramChatConnectTokens.token — link a DELIVERY chat by picking from pending chats
  const db = await getDb();
  if (!db) return;

  // Try system-chat token first (existing behavior)
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramConnectToken, token))
    .limit(1);
  if (user) {
    await handleStartWithToken(chatId, token, from);
    return;
  }

  // Then try delivery token
  const [tok] = await db
    .select()
    .from(telegramChatConnectTokens)
    .where(and(eq(telegramChatConnectTokens.token, token), isNull(telegramChatConnectTokens.usedAt), gt(telegramChatConnectTokens.expiresAt, new Date())))
    .limit(1);

  if (!tok) {
    await sendTelegramMessage(
      chatId,
      "❌ Token topilmadi yoki muddati o'tgan. Iltimos, Targenix.uz saytidan qaytadan urinib ko'ring.",
      "HTML",
    );
    return;
  }

  // List recent pending chats (where bot was added). User picks one to link.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({
      id: telegramPendingChats.id,
      chatId: telegramPendingChats.chatId,
      chatType: telegramPendingChats.chatType,
      title: telegramPendingChats.title,
      username: telegramPendingChats.username,
      botStatus: telegramPendingChats.botStatus,
      lastSeenAt: telegramPendingChats.lastSeenAt,
    })
    .from(telegramPendingChats)
    .where(
      and(
        gt(telegramPendingChats.lastSeenAt, weekAgo),
        // best-effort: only show chats where bot is still present (status from my_chat_member)
        inArray(telegramPendingChats.botStatus, ["member", "administrator"]),
      ),
    )
    .limit(25);

  if (!candidates.length) {
    await sendTelegramMessage(
      chatId,
      "ℹ️ Hozircha bot qo'shilgan guruh/kanal topilmadi.\n\n1) Botni kerakli guruh/kanalga qo'shing.\n2) Keyin shu chatda bot admin/member bo'lib tursin.\n3) So'ng bu linkni qayta oching.",
      "HTML",
    );
    return;
  }

  const keyboard = candidates.slice(0, 10).map((c) => {
    const label =
      (c.title && c.title.length > 0 ? c.title : c.username ? `@${c.username}` : c.chatId) +
      ` (${c.chatType})`;
    // callback_data max 64 bytes → only ids
    return [{ text: label.slice(0, 50), callback_data: `tg:p:${tok.id}:${c.id}` }];
  });

  // Add cancel
  keyboard.push([{ text: "❌ Cancel", callback_data: `tg:px:${tok.id}` }]);

  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Qaysi guruh/kanalni <b>Delivery chat</b> sifatida ulaymiz?\n\nPastdan bittasini tanlang:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
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
  if (!newStatus) return;

  const fromTgUserId = evt.from?.id != null ? String(evt.from.id) : null;

  // If there's an active linking session for the Telegram user who added the bot,
  // attach this chat to that session and proactively ping the user in private.
  const db = await getDb();
  if (db && fromTgUserId) {
    const now = new Date();
    const [session] = await db
      .select()
      .from(telegramLinkingSessions)
      .where(and(eq(telegramLinkingSessions.telegramUserId, fromTgUserId), isNull(telegramLinkingSessions.usedAt), gt(telegramLinkingSessions.expiresAt, now)))
      .limit(1);

    if (session) {
      const title = evt.chat.title ?? null;
      const username = (evt.chat as any)?.username ?? null;
      const chatType = evt.chat.type;

      // Upsert session chat record (best-effort)
      const [existing] = await db
        .select({ id: telegramLinkingSessionChats.id })
        .from(telegramLinkingSessionChats)
        .where(and(eq(telegramLinkingSessionChats.sessionId, session.id), eq(telegramLinkingSessionChats.chatId, chatId)))
        .limit(1);
      if (existing) {
        await db
          .update(telegramLinkingSessionChats)
          .set({ title, username, chatType, botStatus: newStatus, addedByTelegramUserId: fromTgUserId })
          .where(eq(telegramLinkingSessionChats.id, existing.id));
      } else {
        await db.insert(telegramLinkingSessionChats).values({
          sessionId: session.id,
          chatId,
          chatType,
          title,
          username,
          botStatus: newStatus,
          addedByTelegramUserId: fromTgUserId,
          createdAt: new Date(),
        });
      }

      // Build quick picker keyboard for this session (last 10)
      const sessionChats = await db
        .select({
          id: telegramLinkingSessionChats.id,
          chatId: telegramLinkingSessionChats.chatId,
          chatType: telegramLinkingSessionChats.chatType,
          title: telegramLinkingSessionChats.title,
          username: telegramLinkingSessionChats.username,
          botStatus: telegramLinkingSessionChats.botStatus,
        })
        .from(telegramLinkingSessionChats)
        .where(eq(telegramLinkingSessionChats.sessionId, session.id))
        .limit(10);

      const keyboard = sessionChats
        .filter((c) => c.botStatus === "member" || c.botStatus === "administrator")
        .map((c) => {
          const label =
            (c.title && c.title.length > 0 ? c.title : c.username ? `@${c.username}` : c.chatId) +
            ` (${c.chatType})`;
          return [{ text: label.slice(0, 50), callback_data: `tg:lsp:${session.id}:${c.id}` }];
        });
      keyboard.push([{ text: "❌ Bekor qilish", callback_data: `tg:lsx:${session.id}` }]);

      if (keyboard.length) {
        if (!BOT_TOKEN) return;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: fromTgUserId,
            text: "✅ Bot qo‘shildi.\n\nQaysi chatni delivery qilamiz?",
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
          }),
        });
      }

      return; // session flow takes precedence
    }
  }

  // Upsert pending chat record so the user can claim it from private.
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
    "👋 Salom! Bot guruh/kanalga qo'shildi.\n\nUlash uchun Targenix.uz saytida <b>Settings → Telegram → Add delivery chat</b> tugmasini bosing va chiqqan link orqali botni aynan shu chatga qo'shing. Shunda bot bu yerda <b>Confirm</b> tugmasini chiqaradi.",
    "HTML",
  );
}

async function handleCallbackQuery(q: TelegramCallbackQuery): Promise<void> {
  // For delivery linking we require callback to be attached to a message in some chat.
  // If Telegram ever sends a callback without message (inline mode), we can't safely infer the target chat.
  const msgChatId = q.message?.chat?.id;
  const chatId = String(msgChatId ?? q.from?.id ?? "");
  const data = q.data ?? "";

  await log.info("TELEGRAM", "Incoming callback", {
    chatId,
    data: data.slice(0, 80),
    fromUsername: q.from?.username,
    hasMessage: !!q.message,
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

  const db = await getDb();
  if (!db) return;

  // Create a new linking session from private chat
  if (action === "lsn") {
    if (q.message?.chat?.type !== "private") {
      await answer("Open in private chat.", true);
      return;
    }
    const tgUserId = String(q.from.id);
    const now = new Date();

    const [user] = await db
      .select({ id: users.id, telegramUserId: users.telegramUserId })
      .from(users)
      .where(eq(users.telegramUserId, tgUserId))
      .limit(1);

    if (!user) {
      await answer("Not linked yet.", true);
      await sendTelegramMessage(
        chatId,
        "❌ Avval Targenix.uz hisobingizni Telegramga ulang.\n\nTargenix.uz → Settings → Telegram → Connect (System chat) qilib keyin qayta urinib ko‘ring.",
        "HTML",
      );
      return;
    }

    // Invalidate any prior active sessions for this user
    await db
      .update(telegramLinkingSessions)
      .set({ usedAt: now })
      .where(and(eq(telegramLinkingSessions.userId, user.id), isNull(telegramLinkingSessions.usedAt), gt(telegramLinkingSessions.expiresAt, now)));

    const token = `link_${cryptoRandomToken(16)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const [sessionRow] = await db
      .insert(telegramLinkingSessions)
      .values({
        userId: user.id,
        telegramUserId: tgUserId,
        token,
        expiresAt,
        createdAt: now,
      })
      .$returningId();

    // Tell user what to do next
    await answer();
    await sendTelegramMessage(
      chatId,
      "✅ Delivery chat ulashni boshladik.\n\n1) Botni kerakli <b>guruh/kanal</b>ga qo‘shing.\n2) Botni <b>administrator</b> qiling.\n3) So‘ng shu shaxsiy chatga qayting (bot sizga ro‘yxat yuboradi).",
      "HTML",
    );
    // If Telegram supports it, the user can also share/open deep-link; we keep token for audit/debug
    await log.info("TELEGRAM", "Linking session created", { userId: user.id, tgUserId, sessionId: sessionRow?.id, expiresAt });
    return;
  }

  if (!payload && action !== "lsn") return;

  // New format (short): tg:c:<connectTokenRowId> / tg:x:<connectTokenRowId>
  // Pending picker: tg:p:<connectTokenRowId>:<pendingChatId> (sent in private chat)
  // Pending cancel: tg:px:<connectTokenRowId>
  // Pending confirm: tg:pc:<connectTokenRowId>:<pendingChatId>
  // Legacy: tg:confirm:<token> / tg:cancel:<token>
  let tok: typeof telegramChatConnectTokens.$inferSelect | undefined;
  let pendingChat: typeof telegramPendingChats.$inferSelect | undefined;
  let session: typeof telegramLinkingSessions.$inferSelect | undefined;
  let sessionChat: typeof telegramLinkingSessionChats.$inferSelect | undefined;
  if (action === "x" || action === "c") {
    const id = Number(payload);
    if (!Number.isFinite(id)) return;
    const [row] = await db
      .select()
      .from(telegramChatConnectTokens)
      .where(eq(telegramChatConnectTokens.id, id))
      .limit(1);
    tok = row;
  } else if (action === "px") {
    const id = Number(payload);
    if (!Number.isFinite(id)) return;
    const [row] = await db.select().from(telegramChatConnectTokens).where(eq(telegramChatConnectTokens.id, id)).limit(1);
    tok = row;
  } else if (action === "p") {
    // payload is "<connectTokenRowId>:<pendingChatId>"
    const [tokIdRaw, pendingIdRaw] = payload.split(":");
    const tokId = Number(tokIdRaw);
    const pendingId = Number(pendingIdRaw);
    if (!Number.isFinite(tokId) || !Number.isFinite(pendingId)) return;
    const [rowTok] = await db.select().from(telegramChatConnectTokens).where(eq(telegramChatConnectTokens.id, tokId)).limit(1);
    tok = rowTok;
    const [rowPending] = await db.select().from(telegramPendingChats).where(eq(telegramPendingChats.id, pendingId)).limit(1);
    pendingChat = rowPending;
  } else if (action === "pc") {
    // payload is "<connectTokenRowId>:<pendingChatId>"
    const [tokIdRaw, pendingIdRaw] = payload.split(":");
    const tokId = Number(tokIdRaw);
    const pendingId = Number(pendingIdRaw);
    if (!Number.isFinite(tokId) || !Number.isFinite(pendingId)) return;
    const [rowTok] = await db.select().from(telegramChatConnectTokens).where(eq(telegramChatConnectTokens.id, tokId)).limit(1);
    tok = rowTok;
    const [rowPending] = await db.select().from(telegramPendingChats).where(eq(telegramPendingChats.id, pendingId)).limit(1);
    pendingChat = rowPending;
  } else if (action === "cancel" || action === "confirm") {
    const [row] = await db
      .select()
      .from(telegramChatConnectTokens)
      .where(eq(telegramChatConnectTokens.token, payload))
      .limit(1);
    tok = row;
  } else {
    // New session-based onboarding actions
    if (action === "lsx") {
      const sessionId = Number(payload);
      if (!Number.isFinite(sessionId)) return;
      await db.update(telegramLinkingSessions).set({ usedAt: new Date() }).where(eq(telegramLinkingSessions.id, sessionId));
      await answer("Cancelled");
      await sendTelegramMessage(chatId, "❌ Bekor qilindi.", "HTML");
      return;
    }
    if (action === "lsp") {
      // pick chat for session: payload "<sessionId>:<sessionChatRowId>"
      const [sidRaw, scidRaw] = payload.split(":");
      const sid = Number(sidRaw);
      const scid = Number(scidRaw);
      if (!Number.isFinite(sid) || !Number.isFinite(scid)) return;
      const now = new Date();

      const [s] = await db
        .select()
        .from(telegramLinkingSessions)
        .where(and(eq(telegramLinkingSessions.id, sid), isNull(telegramLinkingSessions.usedAt), gt(telegramLinkingSessions.expiresAt, now)))
        .limit(1);
      if (!s || s.telegramUserId !== String(q.from.id)) {
        await answer("Session expired.", true);
        return;
      }
      session = s;
      const [sc] = await db
        .select()
        .from(telegramLinkingSessionChats)
        .where(and(eq(telegramLinkingSessionChats.id, scid), eq(telegramLinkingSessionChats.sessionId, sid)))
        .limit(1);
      if (!sc) {
        await answer("Chat not found.", true);
        return;
      }
      sessionChat = sc;

      const label =
        (sessionChat.title && sessionChat.title.length > 0
          ? sessionChat.title
          : sessionChat.username
            ? `@${sessionChat.username}`
            : sessionChat.chatId) + ` (${sessionChat.chatType})`;

      if (!BOT_TOKEN) return;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Tanlangan chat:\n<b>${escapeHtml(label)}</b>\n\nUlashni tasdiqlaysizmi?`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Confirm", callback_data: `tg:lsc:${sid}:${scid}` },
                { text: "❌ Cancel", callback_data: `tg:lsx:${sid}` },
              ],
            ],
          },
        }),
      });
      await answer();
      return;
    }
    if (action === "lsc") {
      // confirm chat for session: payload "<sessionId>:<sessionChatRowId>"
      const [sidRaw, scidRaw] = payload.split(":");
      const sid = Number(sidRaw);
      const scid = Number(scidRaw);
      if (!Number.isFinite(sid) || !Number.isFinite(scid)) return;
      const now = new Date();

      const [s] = await db
        .select()
        .from(telegramLinkingSessions)
        .where(and(eq(telegramLinkingSessions.id, sid), isNull(telegramLinkingSessions.usedAt), gt(telegramLinkingSessions.expiresAt, now)))
        .limit(1);
      if (!s || s.telegramUserId !== String(q.from.id)) {
        await answer("Session expired.", true);
        return;
      }
      session = s;
      const [sc] = await db
        .select()
        .from(telegramLinkingSessionChats)
        .where(and(eq(telegramLinkingSessionChats.id, scid), eq(telegramLinkingSessionChats.sessionId, sid)))
        .limit(1);
      if (!sc) {
        await answer("Chat not found.", true);
        return;
      }
      sessionChat = sc;

      // Enforce unique ownership
      const [existingChat] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, sessionChat.chatId)).limit(1);
      if (existingChat) {
        await answer("Chat already linked.", true);
        await sendTelegramMessage(chatId, "❌ Bu chat allaqachon ulangan.", "HTML");
        return;
      }

      // Strict permissions: require bot to be admin in the target chat
      const bot = await getBotIdentity();
      if (!bot) {
        await answer("Bot misconfigured.", true);
        return;
      }
      const status = await getChatMemberStatus(sessionChat.chatId, bot.id);
      if (status !== "administrator") {
        await answer("Bot must be admin.", true);
        await sendTelegramMessage(chatId, "❌ Iltimos botni shu chatda <b>administrator</b> qiling va qayta urinib ko‘ring.", "HTML");
        return;
      }

      await db.insert(telegramChats).values({
        userId: session.userId,
        chatId: sessionChat.chatId,
        type: "DELIVERY",
        title: sessionChat.title ?? null,
        username: sessionChat.username ?? null,
        connectedAt: new Date(),
        createdAt: new Date(),
      });

      await db.update(telegramLinkingSessions).set({ usedAt: new Date() }).where(eq(telegramLinkingSessions.id, session.id));

      // Next: mapping choice (minimal)
      if (!BOT_TOKEN) return;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "✅ Delivery chat ulandi.\n\nQaysi joylarga biriktiramiz?",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Hammasiga", callback_data: `tg:lma:${session.userId}:${encodeURIComponent(sessionChat.chatId)}` }],
              [{ text: "⏭️ Hozircha o‘tkazib yuborish", callback_data: `tg:lmskip` }],
            ],
          },
        }),
      });
      await answer("✅ Connected!");
      return;
    }
    if (action === "lma") {
      // Apply to all integrations/targets: payload "<userId>:<chatIdEncoded>"
      const [uidRaw, chatIdEnc] = payload.split(":");
      const uid = Number(uidRaw);
      if (!Number.isFinite(uid) || !chatIdEnc) return;
      const targetChatId = decodeURIComponent(chatIdEnc);

      // Authorize by telegram user id
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.telegramUserId, String(q.from.id))).limit(1);
      if (!user || user.id !== uid) {
        await answer("Not allowed.", true);
        return;
      }

      await db.update(integrations).set({ telegramChatId: targetChatId }).where(eq(integrations.userId, uid));
      await db.update(targetWebsites).set({ telegramChatId: targetChatId }).where(eq(targetWebsites.userId, uid));

      await answer("✅ Done!");
      await sendTelegramMessage(chatId, "✅ Hammasiga biriktirildi.", "HTML");
      return;
    }
    if (action === "lmskip") {
      await answer("OK");
      await sendTelegramMessage(chatId, "✅ Tayyor. Keyin saytdan yoki botdan mappingni o‘zgartirishingiz mumkin.", "HTML");
      return;
    }

    return;
  }

  const isCancel = action === "cancel" || action === "x" || action === "px";
  const isConfirm = action === "confirm" || action === "c";
  const isPick = action === "p";

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

  if (isPick) {
    // Must be in private chat; otherwise don't allow linking from arbitrary chats.
    if (q.message?.chat?.type !== "private") {
      await answer("Open this in private chat.", true);
      return;
    }
    if (!tok || tok.usedAt != null || !(tok.expiresAt > new Date())) {
      await answer("Token expired. Recreate in Settings.", true);
      return;
    }
    if (!pendingChat) {
      await answer("Chat not found.", true);
      return;
    }

    const pickLabel =
      pendingChat.title && pendingChat.title.length > 0
        ? pendingChat.title
        : pendingChat.username
          ? `@${pendingChat.username}`
          : pendingChat.chatId;

    const confirmData = `tg:pc:${tok.id}:${pendingChat.id}`;
    const cancelData = `tg:px:${tok.id}`;

    if (!BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Tanlangan chat:\n<b>${escapeHtml(pickLabel)}</b>\n\nUlashni tasdiqlaysizmi?`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "✅ Confirm", callback_data: confirmData }, { text: "❌ Cancel", callback_data: cancelData }]],
        },
      }),
    });
    await answer();
    return;
  }

  if (action === "pc") {
    // Confirm linking picked pending chat
    if (!tok || tok.usedAt != null || !(tok.expiresAt > new Date())) {
      await answer("Token expired. Recreate in Settings.", true);
      return;
    }
    if (!pendingChat) {
      await answer("Chat not found.", true);
      return;
    }

    const targetChatId = pendingChat.chatId;

    // Enforce unique ownership
    const [existing] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, targetChatId)).limit(1);
    if (existing) {
      await answer("Chat already linked.", true);
      await sendTelegramMessage(chatId, "❌ Bu chat allaqachon boshqa userga ulangan (yoki avvalroq ulangan).", "HTML");
      return;
    }

    // Admin check depends on chat type
    const bot = await getBotIdentity();
    if (!bot) {
      await answer("Bot misconfigured.", true);
      await sendTelegramMessage(chatId, "❌ Bot konfiguratsiyasi xato: TELEGRAM_BOT_TOKEN yo'q.", "HTML");
      return;
    }
    const status = await getChatMemberStatus(targetChatId, bot.id);
    const chatType = pendingChat.chatType;
    const isChannel = chatType === "channel";
    const okStatus = isChannel ? status === "administrator" : status === "administrator" || status === "member";
    if (!okStatus) {
      await log.warn("TELEGRAM", "Confirm blocked: insufficient bot permissions", { targetChatId, chatType, status });
      await answer(isChannel ? "Bot must be admin in channel." : "Bot must be member/admin.", true);
      await sendTelegramMessage(
        chatId,
        isChannel
          ? "❌ Kanalda post qilish uchun bot <b>administrator</b> bo'lishi kerak.\n\nBotga admin huquq bering va qaytadan Confirm qiling."
          : "❌ Bot bu chatda <b>member</b> ham emas.\n\nIltimos botni qayta qo'shing va qaytadan Confirm qiling.",
        "HTML",
      );
      return;
    }

    await db.insert(telegramChats).values({
      userId: tok.userId,
      chatId: targetChatId,
      type: "DELIVERY",
      title: pendingChat.title ?? null,
      username: pendingChat.username ?? null,
      connectedAt: new Date(),
      createdAt: new Date(),
    });

    await db.update(telegramChatConnectTokens).set({ usedAt: new Date() }).where(eq(telegramChatConnectTokens.id, tok.id));

    await sendTelegramMessage(
      chatId,
      "✅ <b>Delivery chat ulandi!</b>\n\nEndi integratsiyalarga biriktirib leadlarni shu yerga yuborishingiz mumkin (Settings → Telegram).",
      "HTML",
    );
    await answer("✅ Connected!");
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

  // Admin check depends on chat type:
  // - channel: administrator required to post
  // - group/supergroup: member is enough for basic sendMessage (still recommended to grant admin)
  const bot = await getBotIdentity();
  if (!bot) {
    await answer("Bot misconfigured.", true);
    await sendTelegramMessage(chatId, "❌ Bot konfiguratsiyasi xato: TELEGRAM_BOT_TOKEN yo'q.", "HTML");
    return;
  }
  const status = await getChatMemberStatus(chatId, bot.id);
  const chatType = q.message?.chat?.type;
  const isChannel = chatType === "channel";
  const okStatus = isChannel ? status === "administrator" : status === "administrator" || status === "member";
  if (!okStatus) {
    await log.warn("TELEGRAM", "Confirm blocked: insufficient bot permissions", { chatId, chatType, status });
    await answer(isChannel ? "Bot must be admin in channel." : "Bot must be member/admin.", true);
    await sendTelegramMessage(
      chatId,
      isChannel
        ? "❌ Kanalda post qilish uchun bot <b>administrator</b> bo'lishi kerak.\n\nBotga admin huquq bering va qaytadan Confirm qiling."
        : "❌ Bot bu chatda <b>member</b> ham emas.\n\nIltimos botni qayta qo'shing va qaytadan Confirm qiling.",
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

function cryptoRandomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
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

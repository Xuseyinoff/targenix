/**
 * Telegram tRPC Router
 *
 * Procedures:
 *   - getStatus: returns current Telegram connection state for the logged-in user
 *   - generateConnectToken: creates a one-time token and returns the bot deep-link URL
 *   - disconnect: clears all Telegram fields from the user record
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { integrations, telegramChats, targetWebsites, users } from "../../drizzle/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import crypto from "crypto";

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "Targenixbot";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

async function getBotId(): Promise<number | null> {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { id: number } };
    return data.ok && data.result?.id ? data.result.id : null;
  } catch {
    return null;
  }
}

async function getChatInfo(chatId: string): Promise<{ title?: string | null; username?: string | null; type?: string | null } | null> {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const data = (await res.json()) as { ok: boolean; result?: { title?: string; username?: string; type?: string } };
    if (!data.ok || !data.result) return null;
    return { title: data.result.title ?? null, username: data.result.username ?? null, type: data.result.type ?? null };
  } catch {
    return null;
  }
}

async function getBotStatusInChat(chatId: string, botId: number): Promise<string | null> {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${botId}`,
    );
    const data = (await res.json()) as { ok: boolean; result?: { status?: string } };
    if (!data.ok) return null;
    return data.result?.status ?? null;
  } catch {
    return null;
  }
}

export const telegramRouter = router({
  /** Get the current user's Telegram connection status */
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const [user] = await db
      .select({
        telegramChatId: users.telegramChatId,
        telegramUsername: users.telegramUsername,
        telegramConnectedAt: users.telegramConnectedAt,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    return {
      connected: !!user?.telegramChatId,
      chatId: user?.telegramChatId ?? null,
      username: user?.telegramUsername ?? null,
      connectedAt: user?.telegramConnectedAt ?? null,
    };
  }),

  /**
   * Generate a one-time connect token and return the Telegram deep-link.
   * The token is stored on the user record and consumed when the bot receives /start <token>.
   */
  generateConnectToken: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    // 32-byte random token, URL-safe base64
    const token = crypto.randomBytes(32).toString("base64url");

    await db
      .update(users)
      .set({ telegramConnectToken: token })
      .where(eq(users.id, ctx.user.id));

    const botUrl = `https://t.me/${BOT_USERNAME}?start=${token}`;
    return { token, botUrl };
  }),

  /**
   * Debug helper: return Telegram webhook status for this bot.
   * Useful to verify that production is pointing Telegram to the same origin as APP_URL.
   */
  getWebhookInfo: protectedProcedure.query(async () => {
    if (!BOT_TOKEN) {
      return {
        ok: false,
        error: "TELEGRAM_BOT_TOKEN not set",
        botUsername: BOT_USERNAME,
        appUrl: process.env.APP_URL ?? null,
        webhookUrl: null as string | null,
      };
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      const data = (await res.json()) as { ok: boolean; result?: { url?: string } };
      return {
        ok: Boolean(data.ok),
        botUsername: BOT_USERNAME,
        appUrl: process.env.APP_URL ?? null,
        webhookUrl: data.result?.url ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err),
        botUsername: BOT_USERNAME,
        appUrl: process.env.APP_URL ?? null,
        webhookUrl: null as string | null,
      };
    }
  }),

  /**
   * Disconnect Telegram and remove all Telegram-related data for this user:
   * - clears system chat link on users
   * - deletes all DELIVERY chats owned by the user
   * - clears mappings that reference delivery chats (integrations/targets)
   */
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    await db.transaction(async (tx) => {
      // Clear mappings first (leads must stop delivering)
      await tx.update(integrations).set({ telegramChatId: null }).where(eq(integrations.userId, ctx.user.id));
      await tx.update(targetWebsites).set({ telegramChatId: null }).where(eq(targetWebsites.userId, ctx.user.id));

      // Remove all delivery chats owned by the user
      await tx.delete(telegramChats).where(eq(telegramChats.userId, ctx.user.id));

      // Finally clear system chat link & token
      await tx
        .update(users)
        .set({
          telegramUserId: null,
          telegramChatId: null,
          telegramUsername: null,
          telegramConnectedAt: null,
          telegramConnectToken: null,
        })
        .where(eq(users.id, ctx.user.id));
    });

    return { success: true };
  }),

  // (duplicate linkDeliveryChatById removed)

  /**
   * Link a delivery chat by chatId entered on the website.
   * Server verifies:
   * - chat exists
   * - bot is administrator in that chat
   * - chatId is not linked to another user
   */
  linkDeliveryChatById: protectedProcedure
    .input(z.object({ chatId: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const chatId = input.chatId.trim();

      const [existing] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
      if (existing) throw new Error("This chat is already linked.");

      const botId = await getBotId();
      if (!botId) throw new Error("Bot is not configured (missing TELEGRAM_BOT_TOKEN).");

      const status = await getBotStatusInChat(chatId, botId);
      if (status !== "administrator") {
        throw new Error("Bot must be administrator in that group/channel.");
      }

      const info = await getChatInfo(chatId);
      if (!info) throw new Error("Chat not found or bot has no access.");

      await db.insert(telegramChats).values({
        userId: ctx.user.id,
        chatId,
        type: "DELIVERY",
        title: info.title ?? null,
        username: info.username ?? null,
        connectedAt: new Date(),
        createdAt: new Date(),
      });

      return { success: true, chatId, title: info.title ?? null, username: info.username ?? null, type: info.type ?? null };
    }),

  /** List delivery chats owned by the current user */
  listDeliveryChats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    return db
      .select({
        id: telegramChats.id,
        chatId: telegramChats.chatId,
        type: telegramChats.type,
        title: telegramChats.title,
        username: telegramChats.username,
        connectedAt: telegramChats.connectedAt,
      })
      .from(telegramChats)
      .where(and(eq(telegramChats.userId, ctx.user.id), eq(telegramChats.type, "DELIVERY")))
      .orderBy(desc(telegramChats.connectedAt));
  }),

  /** List destinations (target_websites) with template info + mapped delivery chat (if any) */
  listDestinationMappings: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const tws = await db
      .select({
        id: targetWebsites.id,
        name: targetWebsites.name,
        url: targetWebsites.url,
        templateType: targetWebsites.templateType,
        templateId: targetWebsites.templateId,
        telegramChatId: targetWebsites.telegramChatId,
        isActive: targetWebsites.isActive,
        createdAt: targetWebsites.createdAt,
      })
      .from(targetWebsites)
      .where(eq(targetWebsites.userId, ctx.user.id))
      .orderBy(desc(targetWebsites.createdAt));

    const chatIds = Array.from(new Set(tws.map((t) => t.telegramChatId).filter((x): x is string => !!x)));
    const chats = chatIds.length
      ? await db
          .select({ id: telegramChats.id, chatId: telegramChats.chatId, title: telegramChats.title })
          .from(telegramChats)
          .where(and(eq(telegramChats.userId, ctx.user.id), eq(telegramChats.type, "DELIVERY"), inArray(telegramChats.chatId, chatIds)))
      : [];
    const byChatId = new Map(chats.map((c) => [c.chatId, c]));

    return tws.map((t) => ({
      id: t.id,
      name: t.name,
      url: t.url,
      templateType: t.templateType,
      templateId: t.templateId,
      isActive: t.isActive,
      createdAt: t.createdAt,
      chat: t.telegramChatId ? byChatId.get(t.telegramChatId) ?? null : null,
    }));
  }),

  /** Get destinations delivery mapping settings (AUTO vs MANUAL) */
  getDestinationDeliverySettings: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const [me] = await db
      .select({
        mode: users.telegramDestinationDeliveryMode,
        defaultChatId: users.telegramDestinationDefaultChatId,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    return {
      mode: me?.mode ?? "MANUAL",
      defaultChatId: me?.defaultChatId ? String(me.defaultChatId) : null,
    } as const;
  }),

  /**
   * Set destinations delivery mapping settings.
   * - ALL: requires defaultChatId (DELIVERY chat owned by user), bulk-applies to all destinations
   * - MANUAL: clears defaultChatId, keeps existing per-destination mappings
   */
  setDestinationDeliverySettings: protectedProcedure
    .input(
      z.object({
        mode: z.enum(["ALL", "MANUAL"]),
        defaultChatId: z.string().trim().min(1).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      if (input.mode === "ALL") {
        const chatId = (input.defaultChatId ?? "").trim();
        if (!chatId) throw new Error("Please select a delivery chat");

        // Validate delivery chat ownership
        const [chat] = await db
          .select({ chatId: telegramChats.chatId, userId: telegramChats.userId, type: telegramChats.type })
          .from(telegramChats)
          .where(and(eq(telegramChats.chatId, chatId), eq(telegramChats.userId, ctx.user.id)))
          .limit(1);
        if (!chat || chat.type !== "DELIVERY") throw new Error("Delivery chat not found");

        await db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({
              telegramDestinationDeliveryMode: "ALL",
              telegramDestinationDefaultChatId: chatId,
            })
            .where(eq(users.id, ctx.user.id));

          // Bulk-apply mapping to all destinations/templates for this user
          await tx
            .update(targetWebsites)
            .set({ telegramChatId: chatId })
            .where(eq(targetWebsites.userId, ctx.user.id));
        });

        return { success: true };
      }

      // MANUAL
      await db
        .update(users)
        .set({
          telegramDestinationDeliveryMode: "MANUAL",
          telegramDestinationDefaultChatId: null,
        })
        .where(eq(users.id, ctx.user.id));

      return { success: true };
    }),

  /** Set destination → delivery chat mapping (stored on target_websites.telegramChatId) */
  setDestinationChat: protectedProcedure
    .input(z.object({ targetWebsiteId: z.number(), telegramChatId: z.string().trim().min(1).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [tw] = await db
        .select({ id: targetWebsites.id, userId: targetWebsites.userId })
        .from(targetWebsites)
        .where(eq(targetWebsites.id, input.targetWebsiteId))
        .limit(1);
      if (!tw || tw.userId !== ctx.user.id) throw new Error("Destination not found");

      if (input.telegramChatId == null) {
        await db.update(targetWebsites).set({ telegramChatId: null }).where(eq(targetWebsites.id, input.targetWebsiteId));
        return { success: true };
      }

      // Validate delivery chat ownership
      const [chat] = await db
        .select({ chatId: telegramChats.chatId, userId: telegramChats.userId, type: telegramChats.type })
        .from(telegramChats)
        .where(eq(telegramChats.chatId, input.telegramChatId))
        .limit(1);
      if (!chat || chat.userId !== ctx.user.id || chat.type !== "DELIVERY") throw new Error("Chat not found");

      await db.update(targetWebsites).set({ telegramChatId: chat.chatId }).where(eq(targetWebsites.id, input.targetWebsiteId));
      return { success: true };
    }),
});

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
import { telegramChatConnectTokens, telegramChats, targetWebsites, users } from "../../drizzle/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import crypto from "crypto";

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "Targenixbot";

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

  /** Disconnect Telegram — clears chat_id, username, connected_at, and any pending token */
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    await db
      .update(users)
      .set({
        telegramChatId: null,
        telegramUsername: null,
        telegramConnectedAt: null,
        telegramConnectToken: null,
      })
      .where(eq(users.id, ctx.user.id));

    return { success: true };
  }),

  /**
   * Create a connect token for linking a DELIVERY chat (group/channel) via inline Confirm.
   * Returns a startgroup link that adds the bot to a group with payload.
   */
  generateDeliveryConnectToken: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await db.insert(telegramChatConnectTokens).values({
      userId: ctx.user.id,
      token,
      expiresAt,
      createdAt: new Date(),
    });

    const botUrl = `https://t.me/${BOT_USERNAME}?startgroup=${token}`;
    return { token, botUrl, expiresAt };
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

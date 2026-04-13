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
import { integrations, telegramChatConnectTokens, telegramChats, telegramChatIntegrations, users } from "../../drizzle/schema";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
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

  /** Map an integration to a delivery chat (and set integration.telegramChatId for fast routing) */
  mapIntegrationToChat: protectedProcedure
    .input(z.object({ integrationId: z.number(), telegramChatId: z.number().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [intg] = await db
        .select({ id: integrations.id, userId: integrations.userId })
        .from(integrations)
        .where(eq(integrations.id, input.integrationId))
        .limit(1);
      if (!intg || intg.userId !== ctx.user.id) throw new Error("Integration not found");

      if (input.telegramChatId == null) {
        await db.delete(telegramChatIntegrations).where(eq(telegramChatIntegrations.integrationId, input.integrationId));
        await db.update(integrations).set({ telegramChatId: null }).where(eq(integrations.id, input.integrationId));
        return { success: true };
      }

      const [chat] = await db
        .select({ id: telegramChats.id, chatId: telegramChats.chatId, userId: telegramChats.userId, type: telegramChats.type })
        .from(telegramChats)
        .where(eq(telegramChats.id, input.telegramChatId))
        .limit(1);
      if (!chat || chat.userId !== ctx.user.id || chat.type !== "DELIVERY") throw new Error("Chat not found");

      await db
        .insert(telegramChatIntegrations)
        .values({ telegramChatId: chat.id, integrationId: input.integrationId, createdAt: new Date() })
        // MySQL: ignore duplicates by checking first
        .catch(() => {});

      await db.update(integrations).set({ telegramChatId: chat.chatId }).where(eq(integrations.id, input.integrationId));

      return { success: true };
    }),

  /** List integrations + their mapped delivery chat (if any) */
  listIntegrationMappings: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const ints = await db
      .select({
        id: integrations.id,
        name: integrations.name,
        type: integrations.type,
        telegramChatId: integrations.telegramChatId,
      })
      .from(integrations)
      .where(and(eq(integrations.userId, ctx.user.id), eq(integrations.type, "LEAD_ROUTING")));

    // Resolve chat records by chatId string
    const chatIds = Array.from(new Set(ints.map((i) => i.telegramChatId).filter((x): x is string => !!x)));
    const chats = chatIds.length
      ? await db
          .select({ id: telegramChats.id, chatId: telegramChats.chatId, title: telegramChats.title })
          .from(telegramChats)
          .where(and(eq(telegramChats.userId, ctx.user.id), eq(telegramChats.type, "DELIVERY"), inArray(telegramChats.chatId, chatIds)))
      : [];
    const byChatId = new Map(chats.map((c) => [c.chatId, c]));

    return ints.map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      chat: i.telegramChatId ? byChatId.get(i.telegramChatId) ?? null : null,
    }));
  }),
});

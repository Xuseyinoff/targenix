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
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
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
});

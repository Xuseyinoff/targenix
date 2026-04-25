/**
 * Google Sheets integration tokens (oauth_tokens) — tRPC: list, getStatus, refresh, disconnect
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { connections, oauthTokens } from "../../drizzle/schema";
import { encrypt, decrypt } from "../encryption";
import { isTokenExpired, refreshGoogleToken, computeExpiryDate, revokeGoogleToken } from "../services/googleService";
import { log } from "../services/appLogger";
import { GOOGLE_SHEETS_APP_KEY } from "../oauth/getOAuthConfig";
import { validateConnectionType } from "../utils/validateConnectionType";

export const googleAccountsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
    }

    return db
      .select({
        id: oauthTokens.id,
        email: oauthTokens.email,
        name: oauthTokens.name,
        picture: oauthTokens.picture,
        expiryDate: oauthTokens.expiryDate,
        connectedAt: oauthTokens.createdAt,
        createdAt: oauthTokens.createdAt,
      })
      .from(oauthTokens)
      .where(
        and(eq(oauthTokens.userId, userId), eq(oauthTokens.appKey, GOOGLE_SHEETS_APP_KEY)),
      )
      .orderBy(desc(oauthTokens.createdAt));
  }),

  getStatus: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      }

      const [account] = await db
        .select({
          id: oauthTokens.id,
          expiryDate: oauthTokens.expiryDate,
          refreshToken: oauthTokens.refreshToken,
        })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.id, input.id),
            eq(oauthTokens.userId, userId),
            eq(oauthTokens.appKey, GOOGLE_SHEETS_APP_KEY),
          ),
        )
        .limit(1);

      if (!account) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Google account not found" });
      }

      const expired = isTokenExpired(account.expiryDate);
      const canRefresh = Boolean(account.refreshToken);

      return {
        id: account.id,
        tokenExpired: expired,
        canRefresh,
        needsReconnect: expired && !canRefresh,
      };
    }),

  refreshToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      }

      const [row] = await db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.id, input.id),
            eq(oauthTokens.userId, userId),
            eq(oauthTokens.appKey, GOOGLE_SHEETS_APP_KEY),
          ),
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Google account not found" });
      }
      if (!row.refreshToken) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No refresh token available — please reconnect your Google account",
        });
      }

      let refreshed;
      try {
        refreshed = await refreshGoogleToken(decrypt(row.refreshToken));
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Token refresh failed: ${String(error)}`,
        });
      }

      const newExpiryDate = computeExpiryDate(refreshed.expires_in);
      await db
        .update(oauthTokens)
        .set({ accessToken: encrypt(refreshed.access_token), expiryDate: newExpiryDate })
        .where(eq(oauthTokens.id, row.id));

      await log.info("GOOGLE", "token refreshed via tRPC (oauth_tokens)", { userId, id: row.id });
      return { success: true, expiryDate: newExpiryDate };
    }),

  disconnect: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      }

      const [row] = await db
        .select({ id: oauthTokens.id, accessToken: oauthTokens.accessToken, email: oauthTokens.email })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.id, input.id),
            eq(oauthTokens.userId, userId),
            eq(oauthTokens.appKey, GOOGLE_SHEETS_APP_KEY),
          ),
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Google account not found" });
      }

      try {
        await revokeGoogleToken(decrypt(row.accessToken));
      } catch {
        // best-effort
      }

      await db
        .update(connections)
        .set({ oauthTokenId: null })
        .where(
          and(
            eq(connections.userId, userId),
            eq(connections.type, validateConnectionType("google_sheets")),
            eq(connections.oauthTokenId, row.id),
          ),
        );

      await db.delete(oauthTokens).where(eq(oauthTokens.id, row.id));
      await log.info("GOOGLE", "google integration token disconnected", {
        userId,
        email: row.email,
        id: row.id,
      });
      return { success: true };
    }),
});

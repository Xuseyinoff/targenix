/**
 * googleAccountsRouter
 *
 * tRPC procedures for managing connected Google accounts:
 *   list         — return all connected Google accounts for the current user
 *   disconnect   — remove a Google account (and revoke token if possible)
 *   getStatus    — check whether an account's token is still valid
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { googleAccounts } from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import { encrypt, decrypt } from "../encryption";
import { isTokenExpired, refreshGoogleToken, computeExpiryDate } from "../services/googleService";
import { log } from "../services/appLogger";
import axios from "axios";

// ─── Router ───────────────────────────────────────────────────────────────────

export const googleAccountsRouter = router({

  // ── list ─────────────────────────────────────────────────────────────────
  // Returns all Google accounts connected by the current user.
  // Access/refresh tokens are NOT returned to the client.
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    return db
      .select({
        id: googleAccounts.id,
        email: googleAccounts.email,
        name: googleAccounts.name,
        picture: googleAccounts.picture,
        expiryDate: googleAccounts.expiryDate,
        connectedAt: googleAccounts.connectedAt,
      })
      .from(googleAccounts)
      .where(and(eq(googleAccounts.userId, userId), eq(googleAccounts.type, "integration")))
      .orderBy(desc(googleAccounts.connectedAt));
  }),

  // ── getStatus ─────────────────────────────────────────────────────────────
  // Returns whether the access token for a given account is valid or needs refresh.
  // Useful for the UI to show a "reconnect" badge without exposing the token.
  getStatus: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [account] = await db
        .select({
          id: googleAccounts.id,
          expiryDate: googleAccounts.expiryDate,
          refreshToken: googleAccounts.refreshToken,
        })
        .from(googleAccounts)
        .where(and(eq(googleAccounts.id, input.id), eq(googleAccounts.userId, userId), eq(googleAccounts.type, "integration")))
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
        // needsReconnect = expired AND no refresh token available
        needsReconnect: expired && !canRefresh,
      };
    }),

  // ── refreshToken ─────────────────────────────────────────────────────────
  // Manually trigger a token refresh for an account.
  // Typically called from the UI when getStatus returns tokenExpired=true.
  refreshToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [account] = await db
        .select()
        .from(googleAccounts)
        .where(and(eq(googleAccounts.id, input.id), eq(googleAccounts.userId, userId), eq(googleAccounts.type, "integration")))
        .limit(1);

      if (!account) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Google account not found" });
      }

      if (!account.refreshToken) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No refresh token available — please reconnect your Google account",
        });
      }

      let refreshed;
      try {
        refreshed = await refreshGoogleToken(decrypt(account.refreshToken));
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Token refresh failed: ${String(error)}`,
        });
      }

      const newExpiryDate = computeExpiryDate(refreshed.expires_in);
      await db
        .update(googleAccounts)
        .set({ accessToken: encrypt(refreshed.access_token), expiryDate: newExpiryDate })
        .where(eq(googleAccounts.id, account.id));

      await log.info("GOOGLE", `token refreshed via tRPC for account ${account.id}`, { userId });

      return { success: true, expiryDate: newExpiryDate };
    }),

  // ── disconnect ────────────────────────────────────────────────────────────
  // Removes a Google account row and revokes the token at Google's servers.
  // Supports multi-account: only the account with the given id is removed.
  disconnect: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [account] = await db
        .select({ id: googleAccounts.id, accessToken: googleAccounts.accessToken, email: googleAccounts.email })
        .from(googleAccounts)
        .where(and(eq(googleAccounts.id, input.id), eq(googleAccounts.userId, userId), eq(googleAccounts.type, "integration")))
        .limit(1);

      if (!account) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Google account not found" });
      }

      // Attempt to revoke token at Google (non-fatal if it fails)
      try {
        const plainToken = decrypt(account.accessToken);
        await axios.post(
          "https://oauth2.googleapis.com/revoke",
          new URLSearchParams({ token: plainToken }).toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 5_000 }
        );
      } catch {
        // Revocation is best-effort — proceed with local deletion regardless
      }

      await db.delete(googleAccounts).where(eq(googleAccounts.id, account.id));

      await log.info("GOOGLE", `account disconnected`, { userId, email: account.email, accountId: account.id });

      return { success: true };
    }),
});

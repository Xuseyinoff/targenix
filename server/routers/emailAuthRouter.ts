/**
 * emailAuthRouter
 *
 * Provides email/password registration and login as an alternative to
 * the Manus OAuth flow. Uses bcrypt for password hashing and issues the
 * same JWT session cookie that the rest of the app already understands.
 */

import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  users, passwordResetTokens, facebookAccounts, facebookConnections,
  facebookForms, facebookOauthStates, targetWebsites, integrations,
  leads, orders, appLogs,
} from "../../drizzle/schema";
import { eq, and, gt } from "drizzle-orm";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { sendPasswordResetEmail } from "../services/emailService";

const BCRYPT_ROUNDS = 12;

/**
 * Derive a stable openId for a brand-new email-only account.
 * Existing OAuth accounts keep their original openId and are found by email column.
 */
function emailToOpenId(email: string): string {
  return `email:${email.toLowerCase().trim()}`;
}

export const emailAuthRouter = router({
  // ── Register ────────────────────────────────────────────────────────────────
  register: publicProcedure
    .input(
      z.object({
        email: z.string().email("Invalid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
        name: z.string().min(1, "Name is required").max(128).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const normalizedEmail = input.email.toLowerCase().trim();
      const openId = emailToOpenId(normalizedEmail);

      // Check for existing account
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.openId, openId))
        .limit(1);

      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists." });
      }

      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

      await db.insert(users).values({
        openId,
        email: normalizedEmail,
        name: input.name ?? normalizedEmail.split("@")[0],
        passwordHash,
        loginMethod: "email",
        lastSignedIn: new Date(),
      });

      // Issue session cookie so the user is immediately logged in
      const sessionToken = await sdk.createSessionToken(openId, {
        name: input.name ?? normalizedEmail.split("@")[0],
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      return { success: true, email: normalizedEmail };
    }),

  // ── Login ────────────────────────────────────────────────────────────────────
  login: publicProcedure
    .input(
      z.object({
        email: z.string().email("Invalid email address"),
        password: z.string().min(1, "Password is required"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const normalizedEmail = input.email.toLowerCase().trim();

      // Look up by email column — this finds BOTH pure email accounts AND
      // OAuth accounts (Google, Apple, etc.) that have a passwordHash set.
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (!user || !user.passwordHash) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }

      const passwordMatch = await bcrypt.compare(input.password, user.passwordHash);
      if (!passwordMatch) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }

      // Update lastSignedIn
      await db
        .update(users)
        .set({ lastSignedIn: new Date() })
        .where(eq(users.openId, user.openId));

      // Issue session using the user's real openId (preserves all their data)
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name ?? normalizedEmail.split("@")[0],
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      return { success: true, email: normalizedEmail, name: user.name };
    }),

  // ── Forgot Password ──────────────────────────────────────────────────────────
  forgotPassword: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const normalizedEmail = input.email.toLowerCase().trim();

      const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      // Always return success to prevent email enumeration
      if (!user) return { success: true };

      // Generate secure random token
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.insert(passwordResetTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      await sendPasswordResetEmail(normalizedEmail, token);

      return { success: true };
    }),

  // ── Reset Password ───────────────────────────────────────────────────────────
  resetPassword: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        password: z.string().min(8, "Password must be at least 8 characters"),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [resetToken] = await db
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.token, input.token),
            gt(passwordResetTokens.expiresAt, new Date()),
          )
        )
        .limit(1);

      if (!resetToken || resetToken.usedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset link." });
      }

      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

      await Promise.all([
        db.update(users).set({ passwordHash }).where(eq(users.id, resetToken.userId)),
        db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, resetToken.id)),
      ]);

      return { success: true };
    }),

  // ── Delete Account (GDPR) ────────────────────────────────────────────────────
  deleteAccount: protectedProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const userId = ctx.user.id;

      // Delete all user data in dependency order (children before parents)
      await db.delete(orders).where(eq(orders.userId, userId));
      await db.delete(leads).where(eq(leads.userId, userId));
      await db.delete(integrations).where(eq(integrations.userId, userId));
      await db.delete(targetWebsites).where(eq(targetWebsites.userId, userId));
      await db.delete(facebookForms).where(eq(facebookForms.userId, userId));
      await db.delete(facebookConnections).where(eq(facebookConnections.userId, userId));
      await db.delete(facebookAccounts).where(eq(facebookAccounts.userId, userId));
      await db.delete(facebookOauthStates).where(eq(facebookOauthStates.userId, userId));
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
      await db.delete(appLogs).where(eq(appLogs.userId, userId));
      await db.delete(users).where(eq(users.id, userId));

      // Clear session cookie
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });

      return { success: true };
    }),
});

/**
 * authRouter — unified authentication router.
 *
 * Procedures:
 *   auth.register        — email + password registration
 *   auth.login           — email + password login
 *   auth.facebookLogin   — Facebook Login (verify access_token via Graph API)
 *   auth.me              — return current user from session
 *   auth.logout          — clear session cookie
 *   auth.forgotPassword  — send password-reset email
 *   auth.resetPassword   — apply new password from reset token
 *   auth.deleteAccount   — GDPR account removal
 */

import { z } from "zod";
import bcrypt from "bcryptjs";
import axios from "axios";
import { TRPCError } from "@trpc/server";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  users,
  passwordResetTokens,
  facebookAccounts,
  facebookConnections,
  facebookForms,
  facebookOauthStates,
  targetWebsites,
  integrations,
  leads,
  orders,
  appLogs,
} from "../../drizzle/schema";
import { eq, and, gt } from "drizzle-orm";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { sendPasswordResetEmail } from "../services/emailService";

const BCRYPT_ROUNDS = 12;

function emailToOpenId(email: string): string {
  return `email:${email.toLowerCase().trim()}`;
}

export const authRouter = router({
  // ── Me ──────────────────────────────────────────────────────────────────────
  me: publicProcedure.query((opts) => opts.ctx.user),

  // ── Logout ──────────────────────────────────────────────────────────────────
  logout: publicProcedure.mutation(({ ctx }) => {
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    return { success: true } as const;
  }),

  // ── Register ─────────────────────────────────────────────────────────────────
  register: publicProcedure
    .input(
      z.object({
        email: z.string().email("Invalid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
        name: z.string().min(1).max(128).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const normalizedEmail = input.email.toLowerCase().trim();
      const openId = emailToOpenId(normalizedEmail);

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

      const sessionToken = await sdk.createSessionToken(openId, {
        name: input.name ?? normalizedEmail.split("@")[0],
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      return { success: true, email: normalizedEmail };
    }),

  // ── Login ─────────────────────────────────────────────────────────────────────
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

      await db
        .update(users)
        .set({ lastSignedIn: new Date() })
        .where(eq(users.openId, user.openId));

      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name ?? normalizedEmail.split("@")[0],
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      return { success: true, email: normalizedEmail, name: user.name };
    }),

  // ── Facebook Login ────────────────────────────────────────────────────────────
  // Frontend calls window.FB.login() to get a short-lived access token,
  // then sends it here. We verify it via the Graph API and create/find the user.
  facebookLogin: publicProcedure
    .input(z.object({ accessToken: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // 1. Verify access token via Facebook Graph API
      let fbProfile: { id: string; name?: string; email?: string };
      try {
        const { data } = await axios.get("https://graph.facebook.com/me", {
          params: { fields: "id,name,email", access_token: input.accessToken },
          timeout: 10_000,
        });
        fbProfile = data;
      } catch {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid Facebook access token." });
      }

      if (!fbProfile.id) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid Facebook access token." });
      }

      const fbOpenId = `fb:${fbProfile.id}`;
      const fbEmail = fbProfile.email?.toLowerCase();

      // 2. Look up user by Facebook openId (returning FB Login user)
      let [user] = await db.select().from(users).where(eq(users.openId, fbOpenId)).limit(1);

      // 3. Look up via facebookAccounts (user who connected FB for Marketing API)
      if (!user) {
        const [fbAccount] = await db
          .select({ userId: facebookAccounts.userId })
          .from(facebookAccounts)
          .where(eq(facebookAccounts.fbUserId, fbProfile.id))
          .limit(1);

        if (fbAccount) {
          const [found] = await db
            .select()
            .from(users)
            .where(eq(users.id, fbAccount.userId))
            .limit(1);
          user = found;
        }
      }

      // 4. Look up by email if available
      if (!user && fbEmail) {
        const [found] = await db
          .select()
          .from(users)
          .where(eq(users.email, fbEmail))
          .limit(1);
        user = found;
      }

      // 5. Create new user
      if (!user) {
        await db.insert(users).values({
          openId: fbOpenId,
          email: fbEmail ?? null,
          name: fbProfile.name ?? null,
          loginMethod: "facebook",
          lastSignedIn: new Date(),
        });
        const [created] = await db
          .select()
          .from(users)
          .where(eq(users.openId, fbOpenId))
          .limit(1);
        user = created;
      }

      if (!user) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create user." });
      }

      await db
        .update(users)
        .set({ lastSignedIn: new Date() })
        .where(eq(users.id, user.id));

      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name ?? "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      return { success: true };
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
            gt(passwordResetTokens.expiresAt, new Date())
          )
        )
        .limit(1);

      if (!resetToken || resetToken.usedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset link." });
      }

      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

      await Promise.all([
        db.update(users).set({ passwordHash }).where(eq(users.id, resetToken.userId)),
        db
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(eq(passwordResetTokens.id, resetToken.id)),
      ]);

      return { success: true };
    }),

  // ── Delete Account (GDPR) ────────────────────────────────────────────────────
  deleteAccount: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    const userId = ctx.user.id;

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

    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });

    return { success: true };
  }),
});

// Legacy export alias — kept for internal imports during migration
export const emailAuthRouter = authRouter;

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
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

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
        name: z
          .string()
          .min(1, "Name is required")
          .max(128)
          .transform((s) => s.replace(/<[^>]*>/g, "").trim())
          .optional(),
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
});

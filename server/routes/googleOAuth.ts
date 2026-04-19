/**
 * Google OAuth 2.0 — Authorization Code Flow
 *
 * Two separate flows, one callback URL:
 *
 * CONNECT FLOW  (user is already logged in — link a Google account)
 *   GET /api/auth/google/initiate          → requires auth, stores userId in state
 *   GET /api/auth/google/callback          → upserts google_accounts, signals targenix_google_oauth
 *
 * LOGIN FLOW  (user is not logged in — sign up / sign in with Google)
 *   GET /api/auth/google/login             → no auth required, stores userId=0 in state
 *   GET /api/auth/google/callback          → creates/finds user, sets session cookie, signals targenix_google_login
 *
 * The callback distinguishes flows by savedState.userId: 0 → login, >0 → connect.
 *
 * Security:
 *  1. Authorization Code Flow — tokens never touch the browser
 *  2. CSRF protection via state parameter (stored in DB, verified on callback, single-use)
 *  3. All token storage is AES-256-CBC encrypted
 *  4. Popup + BroadcastChannel communication (mirrors Facebook OAuth UX)
 */

import type { Express, Request, Response } from "express";
import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { googleAccounts, googleOauthStates, users } from "../../drizzle/schema";
import { encrypt, decrypt } from "../encryption";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, SESSION_EXPIRATION_MS } from "@shared/const";
import { log } from "../services/appLogger";
import {
  buildGoogleAuthUrl,
  exchangeCodeForGoogleTokens,
  getGoogleUserProfile,
  refreshGoogleToken,
  computeExpiryDate,
  isTokenExpired,
  GOOGLE_LOGIN_SCOPES,
} from "../services/googleService";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function cleanupExpiredStates(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.delete(googleOauthStates).where(lt(googleOauthStates.expiresAt, new Date()));
  } catch { /* housekeeping — ignore */ }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders a tiny HTML page that sends a message to the opener
 * via BroadcastChannel (primary) and window.opener.postMessage (fallback).
 */
function renderPopupHtml(
  channelName: string,
  payload: unknown,
  message: string,
  title: string,
): string {
  const safePayload = JSON.stringify(payload);
  const safeMessage = escapeHtml(message);
  const safeTitle = escapeHtml(title);

  return `<!DOCTYPE html>
<html>
  <head><title>${safeTitle}</title><meta charset="utf-8"></head>
  <body>
    <p>${safeMessage}</p>
    <script>
      (function () {
        var payload = ${safePayload};
        try { var bc = new BroadcastChannel(${JSON.stringify(channelName)}); bc.postMessage(payload); bc.close(); } catch (e) {}
        try { if (window.opener && !window.opener.closed) window.opener.postMessage(payload, window.location.origin); } catch (e) {}
        window.close();
      })();
    </script>
  </body>
</html>`;
}

// ─── Upsert google_accounts helper ───────────────────────────────────────────

async function upsertGoogleAccount(
  userId: number,
  profile: { email: string; name: string; picture: string },
  tokens: { accessToken: string; refreshToken?: string; expiryDate: Date },
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const encryptedAccessToken = encrypt(tokens.accessToken);
  const encryptedRefreshToken = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  const [existing] = await db
    .select({ id: googleAccounts.id, refreshToken: googleAccounts.refreshToken })
    .from(googleAccounts)
    .where(and(eq(googleAccounts.userId, userId), eq(googleAccounts.email, profile.email)))
    .limit(1);

  if (existing) {
    await db
      .update(googleAccounts)
      .set({
        name: profile.name,
        picture: profile.picture,
        accessToken: encryptedAccessToken,
        // Preserve existing refresh token if Google didn't return a new one
        ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
        expiryDate: tokens.expiryDate,
        connectedAt: new Date(),
      })
      .where(eq(googleAccounts.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db.insert(googleAccounts).values({
    userId,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken ?? undefined,
    expiryDate: tokens.expiryDate,
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerGoogleOAuthRoutes(app: Express): void {

  // ── GET /api/auth/google/login ─────────────────────────────────────────────
  // Login / Register with Google — no authentication required.
  // Uses userId=0 as sentinel to trigger login flow in callback.
  app.get("/api/auth/google/login", async (req: Request, res: Response) => {
    try {
      const db = await getDb();
      if (!db) { res.status(500).json({ error: "Database not available" }); return; }

      const state = generateState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // userId=0 → login flow (user not yet authenticated)
      await db.insert(googleOauthStates).values({ state, userId: 0, expiresAt });
      cleanupExpiredStates().catch(() => {});

      // Request only email + profile for login (no Sheets/Drive permissions)
      const oauthUrl = buildGoogleAuthUrl(state, GOOGLE_LOGIN_SCOPES);
      res.json({ oauthUrl });
    } catch (error) {
      await log.error("GOOGLE", "login initiate: unexpected error", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate Google login" });
    }
  });

  // ── GET /api/auth/google/initiate ─────────────────────────────────────────
  // Connect Google account — user must be logged in.
  // Requests full scopes (Sheets, Drive) for API access.
  app.get("/api/auth/google/initiate", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

      const db = await getDb();
      if (!db) { res.status(500).json({ error: "Database not available" }); return; }

      const state = generateState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // userId > 0 → connect flow
      await db.insert(googleOauthStates).values({ state, userId: user.id, expiresAt });
      cleanupExpiredStates().catch(() => {});

      const oauthUrl = buildGoogleAuthUrl(state); // full scopes
      res.json({ oauthUrl });
    } catch (error) {
      await log.error("GOOGLE", "initiate: unexpected error", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate Google OAuth" });
    }
  });

  // ── GET /api/auth/google/callback ─────────────────────────────────────────
  // Single callback URL for both connect and login flows.
  // Registered in Google Cloud Console as the redirect_uri.
  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const code = req.query["code"] as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    // ── User denied consent ──────────────────────────────────────────────────
    if (errorParam) {
      res.send(renderPopupHtml(
        "targenix_google_login",
        { type: "google_login_error", error: errorParam },
        "Google login cancelled.",
        "Cancelled",
      ));
      return;
    }

    if (!code || !stateParam) {
      res.status(400).send(renderPopupHtml(
        "targenix_google_login",
        { type: "google_login_error", error: "Missing parameters" },
        "Invalid callback.",
        "Error",
      ));
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res.status(500).send(renderPopupHtml(
          "targenix_google_login",
          { type: "google_login_error", error: "Database not available" },
          "Server error.",
          "Error",
        ));
        return;
      }

      // ── CSRF validation ────────────────────────────────────────────────────
      const [savedState] = await db
        .select()
        .from(googleOauthStates)
        .where(eq(googleOauthStates.state, stateParam))
        .limit(1);

      if (!savedState) {
        res.status(403).send(renderPopupHtml(
          "targenix_google_login",
          { type: "google_login_error", error: "CSRF check failed" },
          "Security validation failed.",
          "Error",
        ));
        return;
      }

      if (new Date() > savedState.expiresAt) {
        await db.delete(googleOauthStates).where(eq(googleOauthStates.id, savedState.id));
        res.status(403).send(renderPopupHtml(
          "targenix_google_login",
          { type: "google_login_error", error: "Session expired" },
          "Session expired — please try again.",
          "Expired",
        ));
        return;
      }

      const { userId: stateUserId } = savedState;
      // Consume state immediately (one-time use)
      await db.delete(googleOauthStates).where(eq(googleOauthStates.id, savedState.id));

      // ── Exchange code for tokens ───────────────────────────────────────────
      let tokens;
      try {
        tokens = await exchangeCodeForGoogleTokens(code);
      } catch (error) {
        await log.error("GOOGLE", "callback: token exchange failed", { error: String(error) });
        res.send(renderPopupHtml(
          stateUserId === 0 ? "targenix_google_login" : "targenix_google_oauth",
          { type: stateUserId === 0 ? "google_login_error" : "google_oauth_error", error: "Token exchange failed" },
          "Could not exchange authorization code.",
          "Error",
        ));
        return;
      }

      const { access_token, refresh_token, expires_in } = tokens;
      const expiryDate = computeExpiryDate(expires_in);

      // ── Fetch user profile ─────────────────────────────────────────────────
      let profile;
      try {
        profile = await getGoogleUserProfile(access_token);
      } catch (error) {
        await log.error("GOOGLE", "callback: profile fetch failed", { error: String(error) });
        res.send(renderPopupHtml(
          stateUserId === 0 ? "targenix_google_login" : "targenix_google_oauth",
          { type: stateUserId === 0 ? "google_login_error" : "google_oauth_error", error: "Failed to fetch profile" },
          "Could not fetch Google profile.",
          "Error",
        ));
        return;
      }

      const tokenData = { accessToken: access_token, refreshToken: refresh_token, expiryDate };

      // ── CONNECT FLOW (stateUserId > 0) ────────────────────────────────────
      if (stateUserId > 0) {
        const accountId = await upsertGoogleAccount(stateUserId, profile, tokenData);
        await log.info("GOOGLE", "account connected", { userId: stateUserId, email: profile.email });

        res.send(renderPopupHtml(
          "targenix_google_oauth",
          { type: "google_oauth_success", accountId, email: profile.email, name: profile.name, picture: profile.picture },
          "Google account connected!",
          "Connected",
        ));
        return;
      }

      // ── LOGIN FLOW (stateUserId === 0) ────────────────────────────────────
      const googleOpenId = `google:${profile.id}`;
      const googleEmail = profile.email.toLowerCase();

      // 1. Find by openId (returning user who has logged in before)
      let [user] = await db.select().from(users).where(eq(users.openId, googleOpenId)).limit(1);

      // 2. Find by google_accounts email (was linked to an existing account)
      if (!user) {
        const [linked] = await db
          .select({ userId: googleAccounts.userId })
          .from(googleAccounts)
          .where(eq(googleAccounts.email, googleEmail))
          .limit(1);
        if (linked) {
          [user] = await db.select().from(users).where(eq(users.id, linked.userId)).limit(1);
        }
      }

      // 3. Find by matching email (merge with existing email/password account)
      if (!user) {
        [user] = await db.select().from(users).where(eq(users.email, googleEmail)).limit(1);
      }

      // 4. Create new user
      if (!user) {
        await db.insert(users).values({
          openId: googleOpenId,
          email: googleEmail,
          name: profile.name ?? null,
          loginMethod: "google",
          lastSignedIn: new Date(),
        });
        [user] = await db.select().from(users).where(eq(users.openId, googleOpenId)).limit(1);
      }

      if (!user) {
        res.send(renderPopupHtml(
          "targenix_google_login",
          { type: "google_login_error", error: "Failed to create account" },
          "Failed to create account.",
          "Error",
        ));
        return;
      }

      await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

      // Persist google_accounts for this user
      await upsertGoogleAccount(user.id, profile, tokenData).catch(() => {});

      // Create session cookie
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name ?? "",
        expiresInMs: SESSION_EXPIRATION_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: SESSION_EXPIRATION_MS });

      await log.info("GOOGLE", "user logged in via Google", { userId: user.id, email: profile.email });

      res.send(renderPopupHtml(
        "targenix_google_login",
        { type: "google_login_success" },
        "Logged in! You can close this window.",
        "Success",
      ));
    } catch (error) {
      await log.error("GOOGLE", "callback: unexpected error", { error: String(error) });
      res.send(renderPopupHtml(
        "targenix_google_login",
        { type: "google_login_error", error: "Unexpected server error" },
        "Something went wrong — please try again.",
        "Error",
      ));
    }
  });
}

// ─── Token middleware helper ──────────────────────────────────────────────────

/**
 * Retrieve a valid (non-expired) access token for a google_accounts row.
 * Auto-refreshes and persists the new token if expired.
 * Call this before every Google API request (Sheets, Drive, etc.).
 */
export async function getValidGoogleAccessToken(accountId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [account] = await db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.id, accountId))
    .limit(1);

  if (!account) throw new Error(`Google account ${accountId} not found`);

  if (!isTokenExpired(account.expiryDate)) {
    return decrypt(account.accessToken);
  }

  if (!account.refreshToken) {
    throw new Error(
      `Google access token expired for account ${accountId} and no refresh token available. ` +
      "User must reconnect their Google account."
    );
  }

  const refreshed = await refreshGoogleToken(decrypt(account.refreshToken));
  const newExpiryDate = computeExpiryDate(refreshed.expires_in);

  await db
    .update(googleAccounts)
    .set({ accessToken: encrypt(refreshed.access_token), expiryDate: newExpiryDate })
    .where(eq(googleAccounts.id, accountId));

  await log.info("GOOGLE", `access token auto-refreshed for account ${accountId}`);
  return refreshed.access_token;
}

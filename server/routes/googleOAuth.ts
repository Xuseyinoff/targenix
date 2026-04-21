/**
 * Google OAuth 2.0 — Two completely independent flows.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FLOW 1: LOGIN / REGISTER  (type = "login")                             │
 * │                                                                         │
 * │  Route:   GET /api/auth/google/login                                    │
 * │  Scopes:  email + profile only                                          │
 * │  Auth:    NOT required — works for unauthenticated users                │
 * │  Result:  Creates / finds a User row, sets JWT session cookie           │
 * │  Signal:  BroadcastChannel("targenix_google_login")                     │
 * │  Token:   Stored in google_accounts with type="login"                   │
 * │           NEVER used for API calls (Sheets, Drive, etc.)                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FLOW 2: GOOGLE INTEGRATION  (type = "integration")                     │
 * │                                                                         │
 * │  Route:   GET /api/auth/google/initiate                                 │
 * │  Scopes:  email + profile + spreadsheets + drive.file + drive.metadata… │
 * │  Auth:    REQUIRED — user must have an active session                   │
 * │  Result:  Stores token in google_accounts with type="integration"       │
 * │           Does NOT create a session or alter the current session        │
 * │  Signal:  BroadcastChannel("targenix_google_oauth")                     │
 * │  Token:   Used ONLY for Google API calls (Sheets, Drive, etc.)          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Single shared callback URL: /api/auth/google/callback
 * Flow is determined by the `type` field stored in `google_oauth_states`.
 *
 * Security:
 *  1. Authorization Code Flow — tokens never touch the browser
 *  2. CSRF state token stored in DB; single-use; 10-minute TTL
 *  3. Integration flow requires valid session at initiation time
 *  4. Access + refresh tokens encrypted with AES-256-CBC before storage
 *  5. Login tokens and integration tokens are stored as separate rows;
 *     API helpers enforce type="integration" at retrieval time
 */

import type { Express, Request, Response } from "express";
import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { googleAccounts, googleOauthStates, users } from "../../drizzle/schema";
import { encrypt, decrypt } from "../encryption";
import { upsertGoogleConnection } from "../services/connectionService";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, SESSION_EXPIRATION_MS } from "@shared/const";
import { log } from "../services/appLogger";
import {
  buildGoogleAuthUrl,
  exchangeCodeForGoogleTokens,
  getGoogleUserProfile,
  refreshGoogleToken,
  revokeGoogleToken,
  computeExpiryDate,
  isTokenExpired,
} from "../services/googleService";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanupExpiredStates(): void {
  getDb()
    .then((db) => db?.delete(googleOauthStates).where(lt(googleOauthStates.expiresAt, new Date())))
    .catch(() => {});
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders a tiny HTML page that posts a message to the opener then closes the popup.
 * Uses BroadcastChannel (primary) + window.opener.postMessage (fallback).
 */
function popupHtml(channel: string, payload: unknown, title: string): string {
  return `<!DOCTYPE html>
<html><head><title>${escapeHtml(title)}</title><meta charset="utf-8"></head>
<body>
<script>
(function(){
  var p=${JSON.stringify(payload)};
  try{var bc=new BroadcastChannel(${JSON.stringify(channel)});bc.postMessage(p);bc.close();}catch(e){}
  try{if(window.opener&&!window.opener.closed)window.opener.postMessage(p,window.location.origin);}catch(e){}
  window.close();
})();
</script>
</body></html>`;
}

// ─── Shared DB helper ─────────────────────────────────────────────────────────

interface UpsertGoogleAccountInput {
  userId: number;
  type: "login" | "integration";
  profile: { email: string; name: string; picture: string };
  accessToken: string;
  refreshToken?: string;
  expiryDate: Date;
  scopes: string;
}

async function upsertGoogleAccount(input: UpsertGoogleAccountInput): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const { userId, type, profile, accessToken, refreshToken, expiryDate, scopes } = input;

  const encryptedAccess  = encrypt(accessToken);
  const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;

  const [existing] = await db
    .select({ id: googleAccounts.id, refreshToken: googleAccounts.refreshToken })
    .from(googleAccounts)
    .where(and(
      eq(googleAccounts.userId, userId),
      eq(googleAccounts.email, profile.email),
      eq(googleAccounts.type, type),
    ))
    .limit(1);

  if (existing) {
    await db
      .update(googleAccounts)
      .set({
        name:        profile.name,
        picture:     profile.picture,
        accessToken: encryptedAccess,
        // Preserve existing refresh token if Google didn't return a new one
        ...(encryptedRefresh ? { refreshToken: encryptedRefresh } : {}),
        expiryDate,
        scopes,
        connectedAt: new Date(),
      })
      .where(eq(googleAccounts.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db.insert(googleAccounts).values({
    userId,
    email:        profile.email,
    name:         profile.name,
    picture:      profile.picture,
    accessToken:  encryptedAccess,
    refreshToken: encryptedRefresh ?? undefined,
    expiryDate,
    type,
    scopes,
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerGoogleOAuthRoutes(app: Express): void {

  // ── GET /api/auth/google/login ─────────────────────────────────────────────
  // FLOW 1: Login / Register — no session required.
  // Requests email + profile scopes only (no API access).
  app.get("/api/auth/google/login", async (req: Request, res: Response) => {
    try {
      const db = await getDb();
      if (!db) { res.status(500).json({ error: "Database not available" }); return; }

      const state = generateState();
      await db.insert(googleOauthStates).values({
        state,
        userId:    0,             // 0 = no authenticated user yet
        type:      "login",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      cleanupExpiredStates();

      res.json({ oauthUrl: buildGoogleAuthUrl(state, "login") });
    } catch (error) {
      await log.error("GOOGLE", "login initiate error", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate Google login" });
    }
  });

  // ── GET /api/auth/google/initiate ─────────────────────────────────────────
  // FLOW 2: Integration — active session required.
  // Requests full scopes: email + profile + spreadsheets + drive.file.
  app.get("/api/auth/google/initiate", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) { res.status(401).json({ error: "Authentication required" }); return; }

      const db = await getDb();
      if (!db) { res.status(500).json({ error: "Database not available" }); return; }

      const state = generateState();
      await db.insert(googleOauthStates).values({
        state,
        userId:    user.id,      // must be > 0 for integration flow
        type:      "integration",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      cleanupExpiredStates();

      res.json({ oauthUrl: buildGoogleAuthUrl(state, "integration") });
    } catch (error) {
      await log.error("GOOGLE", "integration initiate error", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate Google integration" });
    }
  });

  // ── GET /api/auth/google/callback ─────────────────────────────────────────
  // Single callback for both flows.
  // `savedState.type` determines which branch runs.
  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const code       = req.query["code"]  as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    // ── User cancelled ───────────────────────────────────────────────────────
    if (errorParam) {
      // We don't know the flow yet; signal both channels — only the listening one matters
      res.send(popupHtml("targenix_google_login",
        { type: "google_login_error", error: "Access denied" },
        "Cancelled",
      ));
      return;
    }

    if (!code || !stateParam) {
      res.status(400).send(popupHtml("targenix_google_login",
        { type: "google_login_error", error: "Missing parameters" },
        "Error",
      ));
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res.status(500).send(popupHtml("targenix_google_login",
          { type: "google_login_error", error: "Database unavailable" },
          "Error",
        ));
        return;
      }

      // ── CSRF validation ──────────────────────────────────────────────────
      const [savedState] = await db
        .select()
        .from(googleOauthStates)
        .where(eq(googleOauthStates.state, stateParam))
        .limit(1);

      if (!savedState) {
        res.status(403).send(popupHtml("targenix_google_login",
          { type: "google_login_error", error: "CSRF check failed" },
          "Error",
        ));
        return;
      }

      if (new Date() > savedState.expiresAt) {
        await db.delete(googleOauthStates).where(eq(googleOauthStates.id, savedState.id));
        res.status(403).send(popupHtml("targenix_google_login",
          { type: "google_login_error", error: "Session expired" },
          "Expired",
        ));
        return;
      }

      const { userId: stateUserId, type: flowType } = savedState;
      // Consume state immediately (one-time use)
      await db.delete(googleOauthStates).where(eq(googleOauthStates.id, savedState.id));

      // BroadcastChannel name depends on flow
      const channel = flowType === "login" ? "targenix_google_login" : "targenix_google_oauth";

      // ── Exchange code ────────────────────────────────────────────────────
      let tokens;
      try {
        tokens = await exchangeCodeForGoogleTokens(code);
      } catch (error) {
        await log.error("GOOGLE", "token exchange failed", { error: String(error), flowType });
        res.send(popupHtml(channel,
          { type: flowType === "login" ? "google_login_error" : "google_oauth_error",
            error: "Token exchange failed" },
          "Error",
        ));
        return;
      }

      const { access_token, refresh_token, expires_in, scope } = tokens;
      const expiryDate = computeExpiryDate(expires_in);

      // ── Fetch profile ────────────────────────────────────────────────────
      let profile;
      try {
        profile = await getGoogleUserProfile(access_token);
      } catch (error) {
        await log.error("GOOGLE", "profile fetch failed", { error: String(error), flowType });
        res.send(popupHtml(channel,
          { type: flowType === "login" ? "google_login_error" : "google_oauth_error",
            error: "Failed to fetch Google profile" },
          "Error",
        ));
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // FLOW 2: INTEGRATION — store tokens, DO NOT touch session
      // ════════════════════════════════════════════════════════════════════
      if (flowType === "integration") {
        // stateUserId must be > 0 (validated at initiate time)
        if (!stateUserId || stateUserId <= 0) {
          res.status(403).send(popupHtml(channel,
            { type: "google_oauth_error", error: "Integration requires an authenticated user" },
            "Error",
          ));
          return;
        }

        const accountId = await upsertGoogleAccount({
          userId:       stateUserId,
          type:         "integration",
          profile:      { email: profile.email, name: profile.name ?? "", picture: profile.picture ?? "" },
          accessToken:  access_token,
          refreshToken: refresh_token,
          expiryDate,
          scopes:       scope,
        });

        // Phase 3 — mirror this account into the unified connections table so
        // it shows up on /connections and is pickable from destination forms.
        // Failure here must never break OAuth — the legacy google_accounts row
        // is already persisted and adapters fall back to it via templateConfig.
        let connectionId: number | null = null;
        try {
          connectionId = await upsertGoogleConnection(db, {
            userId:          stateUserId,
            googleAccountId: accountId,
            email:           profile.email,
            displayName:     profile.name?.trim()
              ? `${profile.name} (${profile.email})`
              : profile.email,
          });
        } catch (err) {
          await log.warn("GOOGLE", "connections row upsert failed (non-fatal)", {
            userId: stateUserId,
            accountId,
            error:  String(err),
          });
        }

        await log.info("GOOGLE", "integration account connected", {
          userId: stateUserId,
          email:  profile.email,
          accountId,
          connectionId,
        });

        res.send(popupHtml(channel, {
          type:      "google_oauth_success",
          accountId,
          email:     profile.email,
          name:      profile.name,
          picture:   profile.picture,
          scopes:    scope,
        }, "Connected"));
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // FLOW 1: LOGIN — find / create user, issue session
      // ════════════════════════════════════════════════════════════════════
      const googleOpenId = `google:${profile.id}`;
      const email        = profile.email.toLowerCase();

      // Priority: openId → linked google_accounts → matching email
      let [user] = await db.select().from(users).where(eq(users.openId, googleOpenId)).limit(1);

      if (!user) {
        const [linked] = await db
          .select({ userId: googleAccounts.userId })
          .from(googleAccounts)
          .where(and(eq(googleAccounts.email, email), eq(googleAccounts.type, "login")))
          .limit(1);
        if (linked) {
          [user] = await db.select().from(users).where(eq(users.id, linked.userId)).limit(1);
        }
      }

      if (!user) {
        [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      }

      if (!user) {
        await db.insert(users).values({
          openId:      googleOpenId,
          email,
          name:        profile.name ?? null,
          loginMethod: "google",
          lastSignedIn: new Date(),
        });
        [user] = await db.select().from(users).where(eq(users.openId, googleOpenId)).limit(1);
      }

      if (!user) {
        res.send(popupHtml(channel,
          { type: "google_login_error", error: "Failed to create account" },
          "Error",
        ));
        return;
      }

      await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

      // Persist login token (type="login") — identity record only
      await upsertGoogleAccount({
        userId:       user.id,
        type:         "login",
        profile:      { email, name: profile.name ?? "", picture: profile.picture ?? "" },
        accessToken:  access_token,
        refreshToken: refresh_token,
        expiryDate,
        scopes:       scope,
      }).catch(() => {});

      // Issue JWT session cookie
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name:        user.name ?? "",
        expiresInMs: SESSION_EXPIRATION_MS,
      });
      res.cookie(COOKIE_NAME, sessionToken, {
        ...getSessionCookieOptions(req),
        maxAge: SESSION_EXPIRATION_MS,
      });

      await log.info("GOOGLE", "user logged in", { userId: user.id, email });

      res.send(popupHtml(channel, { type: "google_login_success" }, "Logged In"));

    } catch (error) {
      await log.error("GOOGLE", "callback unexpected error", { error: String(error) });
      res.send(popupHtml("targenix_google_login",
        { type: "google_login_error", error: "Unexpected error" },
        "Error",
      ));
    }
  });
}

// ─── API access helper (integration tokens only) ──────────────────────────────

/**
 * Return a valid, non-expired access token for a google_accounts row.
 * Auto-refreshes and persists the new token if expired.
 *
 * IMPORTANT: only works with type="integration" accounts.
 * Throws clearly if called with a login-type account.
 *
 * Usage: call before every Google Sheets / Drive API request.
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

  if (account.type !== "integration") {
    throw new Error(
      `Account ${accountId} is a login account (type="${account.type}"). ` +
      "Only integration accounts may be used for API calls. " +
      "Have the user connect Google Sheets from the Integrations page."
    );
  }

  // Token still valid
  if (!isTokenExpired(account.expiryDate)) {
    return decrypt(account.accessToken);
  }

  // Need to refresh
  if (!account.refreshToken) {
    throw new Error(
      `Integration account ${accountId} has an expired token and no refresh token. ` +
      "User must reconnect Google Sheets."
    );
  }

  const refreshed = await refreshGoogleToken(decrypt(account.refreshToken));
  const newExpiry  = computeExpiryDate(refreshed.expires_in);

  await db
    .update(googleAccounts)
    .set({ accessToken: encrypt(refreshed.access_token), expiryDate: newExpiry })
    .where(eq(googleAccounts.id, accountId));

  await log.info("GOOGLE", `integration token refreshed`, { accountId });
  return refreshed.access_token;
}

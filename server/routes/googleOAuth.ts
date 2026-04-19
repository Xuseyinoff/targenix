/**
 * Google OAuth 2.0 — Authorization Code Flow
 *
 * Security:
 *  1. Authorization Code Flow — tokens never touch the browser
 *  2. CSRF protection via `state` parameter (stored in DB, verified on callback)
 *  3. Token exchange and storage happen server-side only
 *  4. Both access_token and refresh_token stored AES-256-CBC encrypted
 *  5. Popup + BroadcastChannel strategy (mirrors Facebook OAuth UX)
 *
 * Routes:
 *  GET /api/auth/google/initiate  — must be called while the user is logged in;
 *                                   returns { oauthUrl } pointing to Google consent
 *  GET /api/auth/google/callback  — receives code+state from Google; exchanges,
 *                                   upserts google_accounts, signals popup to close
 */

import type { Express, Request, Response } from "express";
import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { googleAccounts, googleOauthStates } from "../../drizzle/schema";
import { encrypt, decrypt } from "../encryption";
import { sdk } from "../_core/sdk";
import { log } from "../services/appLogger";
import {
  buildGoogleAuthUrl,
  exchangeCodeForGoogleTokens,
  getGoogleUserProfile,
  refreshGoogleToken,
  computeExpiryDate,
  isTokenExpired,
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
  } catch {
    // Non-critical housekeeping — ignore
  }
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
 * Renders a small HTML page that posts a message to the opener via BroadcastChannel
 * (primary) and window.opener.postMessage (fallback), then closes the popup.
 */
function renderPopupBridgeHtml(payload: unknown, message: string, title: string): string {
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

        // 1. BroadcastChannel — primary; works even when COOP nullifies window.opener
        try {
          var bc = new BroadcastChannel("targenix_google_oauth");
          bc.postMessage(payload);
          bc.close();
        } catch (e) {}

        // 2. window.opener.postMessage — fallback
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, window.location.origin);
          }
        } catch (e) {}

        window.close();
      })();
    </script>
  </body>
</html>`;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerGoogleOAuthRoutes(app: Express): void {

  // ── GET /api/auth/google/initiate ─────────────────────────────────────────
  // Called by the frontend (opens a popup or redirects).
  // Returns { oauthUrl } — the consent-screen URL the client should open.
  app.get("/api/auth/google/initiate", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "Database not available" });
        return;
      }

      // Generate CSRF state token valid for 10 minutes
      const state = generateState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.insert(googleOauthStates).values({ state, userId: user.id, expiresAt });

      // Async housekeeping — don't block response
      cleanupExpiredStates().catch(() => {});

      const oauthUrl = buildGoogleAuthUrl(state);
      res.json({ oauthUrl });
    } catch (error) {
      await log.error("GOOGLE", "initiate: unexpected error", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate Google OAuth flow" });
    }
  });

  // ── GET /api/auth/google/callback ─────────────────────────────────────────
  // Google redirects here after the user grants/denies consent.
  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const code = req.query["code"] as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    try {
      // ── User denied consent ────────────────────────────────────────────────
      if (errorParam) {
        res.send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: errorParam },
          "Connection cancelled.",
          "Cancelled",
        ));
        return;
      }

      // ── Missing required params ────────────────────────────────────────────
      if (!code || !stateParam) {
        res.status(400).send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: "Missing code or state parameter" },
          "Invalid callback — missing parameters.",
          "Error",
        ));
        return;
      }

      const db = await getDb();
      if (!db) {
        res.status(500).send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: "Database not available" },
          "Server error — please try again.",
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
        res.status(403).send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: "State mismatch — CSRF check failed" },
          "Security validation failed.",
          "Error",
        ));
        return;
      }

      if (new Date() > savedState.expiresAt) {
        await db.delete(googleOauthStates).where(eq(googleOauthStates.id, savedState.id));
        res.status(403).send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: "OAuth session expired" },
          "Session expired — please try again.",
          "Expired",
        ));
        return;
      }

      const userId = savedState.userId;
      // Consume the state immediately (one-time use)
      await db.delete(googleOauthStates).where(eq(googleOauthStates.id, savedState.id));

      // ── Exchange code for tokens ───────────────────────────────────────────
      let tokens;
      try {
        tokens = await exchangeCodeForGoogleTokens(code);
      } catch (error) {
        await log.error("GOOGLE", "callback: token exchange failed", { error: String(error) });
        res.send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: "Token exchange failed" },
          "Could not exchange authorization code — please try again.",
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
        res.send(renderPopupBridgeHtml(
          { type: "google_oauth_error", error: "Could not fetch Google profile" },
          "Connected but failed to fetch profile — please try again.",
          "Error",
        ));
        return;
      }

      // ── Encrypt tokens ─────────────────────────────────────────────────────
      const encryptedAccessToken = encrypt(access_token);
      const encryptedRefreshToken = refresh_token ? encrypt(refresh_token) : null;

      // ── Upsert google_accounts ─────────────────────────────────────────────
      const [existing] = await db
        .select({ id: googleAccounts.id, refreshToken: googleAccounts.refreshToken })
        .from(googleAccounts)
        .where(and(eq(googleAccounts.userId, userId), eq(googleAccounts.email, profile.email)))
        .limit(1);

      let accountId: number;

      if (existing) {
        accountId = existing.id;
        await db
          .update(googleAccounts)
          .set({
            name: profile.name,
            picture: profile.picture,
            accessToken: encryptedAccessToken,
            // Preserve existing refresh token if Google didn't return a new one
            // (Google only returns refresh_token on first consent or after revocation)
            ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
            expiryDate,
            connectedAt: new Date(),
          })
          .where(eq(googleAccounts.id, existing.id));
      } else {
        const [inserted] = await db.insert(googleAccounts).values({
          userId,
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken ?? undefined,
          expiryDate,
        });
        accountId = (inserted as unknown as { insertId: number }).insertId;
      }

      await log.info("GOOGLE", `account upserted`, { userId, email: profile.email, accountId });

      res.send(renderPopupBridgeHtml(
        {
          type: "google_oauth_success",
          accountId,
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
        },
        "Google account connected successfully!",
        "Connected",
      ));
    } catch (error) {
      await log.error("GOOGLE", "callback: unexpected error", { error: String(error) });
      res.send(renderPopupBridgeHtml(
        { type: "google_oauth_error", error: "Unexpected server error" },
        "Something went wrong — please try again.",
        "Error",
      ));
    }
  });
}

// ─── Token middleware helper ──────────────────────────────────────────────────

/**
 * Retrieve a valid (non-expired) access token for a google_accounts row.
 * Automatically refreshes and persists the new token if expired.
 *
 * Usage: call this before any Google API request (Sheets, Drive, etc.)
 *
 * @throws if no refresh token is available and the access token is expired
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

  // Token still valid — decrypt and return
  if (!isTokenExpired(account.expiryDate)) {
    return decrypt(account.accessToken);
  }

  // Token expired — need to refresh
  if (!account.refreshToken) {
    throw new Error(
      `Google access token expired for account ${accountId} and no refresh token is available. ` +
      "User must reconnect their Google account."
    );
  }

  const decryptedRefreshToken = decrypt(account.refreshToken);

  let refreshed;
  try {
    refreshed = await refreshGoogleToken(decryptedRefreshToken);
  } catch (error) {
    throw new Error(`Failed to refresh Google token for account ${accountId}: ${String(error)}`);
  }

  const newExpiryDate = computeExpiryDate(refreshed.expires_in);
  const newEncryptedAccessToken = encrypt(refreshed.access_token);

  // Persist the refreshed token
  await db
    .update(googleAccounts)
    .set({ accessToken: newEncryptedAccessToken, expiryDate: newExpiryDate })
    .where(eq(googleAccounts.id, accountId));

  await log.info("GOOGLE", `access token refreshed for account ${accountId}`);

  return refreshed.access_token;
}

/**
 * Facebook Authorization Code Flow — Server-Side OAuth Callback
 *
 * Security features:
 *  1. Authorization Code Flow (response_type=code) — token never touches browser
 *  2. CSRF protection via state parameter (stored in DB, verified on callback)
 *  3. Token exchange happens server-side only
 *  4. Immediate exchange for Long-Lived token (60 days)
 *  5. Business Manager pages fetched in addition to personal pages
 */

import type { Express, Request, Response } from "express";
import { getDb } from "../db";
import { facebookOauthStates, facebookAccounts, facebookConnections } from "../../drizzle/schema";
import { eq, and, lt } from "drizzle-orm";
import { encrypt } from "../encryption";
import { log } from "../services/appLogger";
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getFbUserProfile,
  getAllGrantedPages,
  getBusinessManagerPages,
  subscribePageToApp,
} from "../services/facebookGraphService";
import { upsertFormsForPage } from "../services/facebookFormsService";
import { ENV } from "../_core/env";
import { sdk } from "../_core/sdk";
import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";

const FB_CALLBACK_PATH = "/api/auth/facebook/callback";

/**
 * Get the Facebook OAuth callback URL based on APP_URL env var.
 * Falls back to a relative path for local development.
 */
function getRequestOrigin(req: Request): string | null {
  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedHostHeader = req.headers["x-forwarded-host"];

  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : forwardedProtoHeader?.split(",")[0];
  const forwardedHost = Array.isArray(forwardedHostHeader)
    ? forwardedHostHeader[0]
    : forwardedHostHeader?.split(",")[0];

  const protocol = forwardedProto?.trim() || req.protocol;
  const host = forwardedHost?.trim() || req.headers.host;

  if (!protocol || !host) return null;
  return `${protocol}://${host}`;
}

export function getFacebookCallbackUrl(req?: Request): string {
  const requestOrigin = req ? getRequestOrigin(req) : null;
  if (requestOrigin) {
    return `${requestOrigin}${FB_CALLBACK_PATH}`;
  }

  const appUrl = ENV.appUrl;
  if (appUrl) {
    // Strip any path/trailing-slash from APP_URL — keep only origin (scheme + host + port)
    try {
      const { origin } = new URL(appUrl);
      return `${origin}${FB_CALLBACK_PATH}`;
    } catch {
      // Fallback: strip trailing slash and any path after the domain
      const base = appUrl.replace(/\/$/, "").replace(/(\/[^/].*)$/, "");
      return `${base}${FB_CALLBACK_PATH}`;
    }
  }
  return FB_CALLBACK_PATH;
}

/**
 * Generate a cryptographically random state token for CSRF protection.
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Clean up expired OAuth states from DB (housekeeping).
 */
async function cleanupExpiredStates(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.delete(facebookOauthStates).where(lt(facebookOauthStates.expiresAt, new Date()));
  } catch {
    // Non-critical — ignore cleanup errors
  }
}

/**
 * Register the Facebook OAuth routes:
 *  GET /api/auth/facebook/initiate  — generate state, redirect to Facebook
 *  GET /api/auth/facebook/callback  — receive code+state, exchange for token, save
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPopupBridgeHtml(payload: unknown, message: string, title: string): string {
  const payloadJson = JSON.stringify(payload);
  const safeMessage = escapeHtml(message);
  const safeTitle = escapeHtml(title);

  // Two-channel strategy:
  //  1. BroadcastChannel  — primary, immune to Facebook's COOP header which nullifies
  //                         window.opener when the popup navigates to facebook.com
  //  2. window.opener.postMessage — backup for environments without BroadcastChannel
  return `<!DOCTYPE html>
<html>
  <head><title>${safeTitle}</title><meta charset="utf-8"></head>
  <body>
    <p>${safeMessage}</p>
    <script>
      (function () {
        var payload = ${payloadJson};

        // 1. BroadcastChannel — works even when COOP breaks window.opener
        try {
          var bc = new BroadcastChannel("targenix_fb_oauth");
          bc.postMessage(payload);
          bc.close();
        } catch (e) {}

        // 2. window.opener.postMessage — fallback (may be null due to COOP)
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

export function registerFacebookOAuthRoutes(app: Express): void {
  // ── Initiate OAuth flow ──────────────────────────────────────────────────────
  app.get("/api/auth/facebook/initiate", async (req: Request, res: Response) => {
    try {
      // Verify the user is authenticated (must be logged in to connect Facebook)
      const cookies = parseCookieHeader(req.headers.cookie ?? "");
      const sessionCookie = cookies[COOKIE_NAME];
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

      // Generate CSRF state token
      const state = generateState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Save state to DB linked to this user
      await db.insert(facebookOauthStates).values({
        state,
        userId: user.id,
        expiresAt,
      });

      // Clean up old expired states (non-blocking)
      cleanupExpiredStates().catch(() => {});

      const appId = ENV.facebookAppId;
      if (!appId) {
        res.status(500).json({ error: "FACEBOOK_APP_ID not configured" });
        return;
      }

      const callbackUrl = getFacebookCallbackUrl(req);
      const permissions = [
        "public_profile",
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_metadata",
        "leads_retrieval",
        "pages_manage_ads",
        "business_management",
        "ads_management",
      ].join(",");

      const oauthUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
      oauthUrl.searchParams.set("client_id", appId);
      oauthUrl.searchParams.set("redirect_uri", callbackUrl);
      oauthUrl.searchParams.set("scope", permissions);
      oauthUrl.searchParams.set("state", state);
      oauthUrl.searchParams.set("response_type", "code");
      oauthUrl.searchParams.set("display", "popup");
      oauthUrl.searchParams.set("auth_type", "rerequest");

      await log.info("FACEBOOK", "OAuth flow initiated", {
        userId: user.id,
        callbackUrl,
        state: state.slice(0, 8) + "...",
      });

      // Return the URL for the frontend to open as popup
      res.json({ oauthUrl: oauthUrl.toString() });
    } catch (error) {
      await log.error("FACEBOOK", "Failed to initiate OAuth flow", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate OAuth flow" });
    }
  });

  // ── OAuth Callback ───────────────────────────────────────────────────────────
  app.get(FB_CALLBACK_PATH, async (req: Request, res: Response) => {
    const code = req.query["code"] as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    // Handle user denial
    if (errorParam) {
      await log.warn("FACEBOOK", "OAuth callback: user denied permissions", { error: errorParam });
      res.send(
        renderPopupBridgeHtml(
          { type: "fb_oauth_error", error: errorParam },
          "Facebook connection cancelled. You can close this window.",
          "Facebook Connection Cancelled"
        )
      );
      return;
    }

    if (!code || !stateParam) {
      res.status(400).send(
        renderPopupBridgeHtml(
          { type: "fb_oauth_error", error: "Missing code or state" },
          "Invalid OAuth callback. You can close this window.",
          "Facebook Connection Failed"
        )
      );
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res.status(500).send("<p>Database not available</p>");
        return;
      }

      // ── CSRF Verification ──────────────────────────────────────────────────
      const [savedState] = await db
        .select()
        .from(facebookOauthStates)
        .where(eq(facebookOauthStates.state, stateParam))
        .limit(1);

      if (!savedState) {
        await log.error("FACEBOOK", "OAuth CSRF check failed: state not found", {
          state: stateParam.slice(0, 8) + "...",
        });
        res.status(403).send(
          renderPopupBridgeHtml(
            { type: "fb_oauth_error", error: "CSRF validation failed" },
            "Security validation failed. Please try again.",
            "Facebook Connection Failed"
          )
        );
        return;
      }

      // Check state expiry
      if (new Date() > savedState.expiresAt) {
        await db.delete(facebookOauthStates).where(eq(facebookOauthStates.id, savedState.id));
        await log.error("FACEBOOK", "OAuth CSRF check failed: state expired", {
          userId: savedState.userId,
        });
        res.status(403).send(
          renderPopupBridgeHtml(
            { type: "fb_oauth_error", error: "OAuth session expired. Please try again." },
            "OAuth session expired. Please try again.",
            "Facebook Connection Failed"
          )
        );
        return;
      }

      const userId = savedState.userId;

      // Delete state after use (one-time use)
      await db.delete(facebookOauthStates).where(eq(facebookOauthStates.id, savedState.id));

      const appId = ENV.facebookAppId;
      const appSecret = ENV.facebookAppSecret;

      if (!appId || !appSecret) {
        res.status(500).send("<p>Facebook app credentials not configured</p>");
        return;
      }

      const callbackUrl = getFacebookCallbackUrl(req);

      // ── Step 1: Exchange code for short-lived token ────────────────────────
      await log.info("FACEBOOK", "Exchanging authorization code for token", { userId });
      const shortLivedToken = await exchangeCodeForToken(code, appId, appSecret, callbackUrl);

      // ── Step 2: Exchange for long-lived token immediately ──────────────────
      let longLivedToken = shortLivedToken;
      let expiresAt: Date | null = null;
      try {
        const exchanged = await exchangeForLongLivedToken(shortLivedToken, appId, appSecret);
        longLivedToken = exchanged.access_token;
        if (exchanged.expires_in) {
          expiresAt = new Date(Date.now() + exchanged.expires_in * 1000);
        }
        await log.info("FACEBOOK", "Long-lived token obtained", {
          userId,
          expiresAt: expiresAt?.toISOString(),
        });
      } catch (err) {
        await log.warn("FACEBOOK", "Long-lived token exchange failed, using short-lived token", {
          error: String(err),
        });
      }

      // ── Step 3: Fetch user profile ─────────────────────────────────────────
      const profile = await getFbUserProfile(longLivedToken);
      const encryptedUserToken = encrypt(longLivedToken);
      const now = new Date();

      // ── Step 4: Upsert facebookAccounts ───────────────────────────────────
      const existingAccount = await db
        .select({ id: facebookAccounts.id })
        .from(facebookAccounts)
        .where(and(eq(facebookAccounts.userId, userId), eq(facebookAccounts.fbUserId, profile.id)))
        .limit(1);

      let accountId: number;
      if (existingAccount.length > 0) {
        accountId = existingAccount[0].id;
        await db
          .update(facebookAccounts)
          .set({
            fbUserName: profile.name,
            accessToken: encryptedUserToken,
            tokenExpiresAt: expiresAt ?? undefined,
            connectedAt: now,
          })
          .where(and(eq(facebookAccounts.userId, userId), eq(facebookAccounts.fbUserId, profile.id)));
      } else {
        const [inserted] = await db.insert(facebookAccounts).values({
          userId,
          fbUserId: profile.id,
          fbUserName: profile.name,
          accessToken: encryptedUserToken,
          tokenExpiresAt: expiresAt ?? undefined,
          connectedAt: now,
        });
        accountId = (inserted as unknown as { insertId: number }).insertId;
      }

      // ── Step 5: Fetch ALL granted pages (personal + Business Manager) ──────
      const pages = await getAllGrantedPages(longLivedToken, appId, appSecret);

      // Also fetch Business Manager pages
      let bmPages: typeof pages = [];
      try {
        bmPages = await getBusinessManagerPages(longLivedToken, appId, appSecret);
        await log.info("FACEBOOK", `Business Manager pages fetched: ${bmPages.length}`, {
          userId,
          pageIds: bmPages.map((p) => p.id),
        });
      } catch (err) {
        await log.warn("FACEBOOK", "Business Manager pages fetch failed (non-critical)", {
          error: String(err),
        });
      }

      // Merge and deduplicate pages
      const pageMap = new Map(pages.map((p) => [p.id, p]));
      for (const p of bmPages) {
        if (!pageMap.has(p.id)) {
          pageMap.set(p.id, p);
        }
      }
      const allPages = Array.from(pageMap.values());
      const returnedPageIds = new Set(allPages.map((p) => p.id));

      await log.info("FACEBOOK", `Total pages after merge: ${allPages.length}`, {
        userId,
        personalPages: pages.length,
        bmPages: bmPages.length,
      });

      // ── Step 6: Deactivate pages no longer returned ────────────────────────
      const existingConns = await db
        .select({ id: facebookConnections.id, pageId: facebookConnections.pageId })
        .from(facebookConnections)
        .where(
          and(
            eq(facebookConnections.userId, userId),
            eq(facebookConnections.facebookAccountId, accountId)
          )
        );

      for (const conn of existingConns) {
        if (!returnedPageIds.has(conn.pageId)) {
          await db
            .update(facebookConnections)
            .set({ isActive: false, subscriptionStatus: "inactive" })
            .where(eq(facebookConnections.id, conn.id));
        }
      }

      // ── Step 7: Subscribe each page and upsert connection ─────────────────
      const results: Array<{
        pageId: string;
        pageName: string;
        subscribed: boolean;
        isNew: boolean;
        error?: string;
      }> = [];

      for (const page of allPages) {
        let subscribed = false;
        let subscriptionError: string | undefined;

        try {
          await subscribePageToApp(page.id, page.access_token);
          subscribed = true;
        } catch (err) {
          subscriptionError = err instanceof Error ? err.message : String(err);
        }

        const encryptedPageToken = encrypt(page.access_token);
        const existingConn = await db
          .select({ id: facebookConnections.id })
          .from(facebookConnections)
          .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.pageId, page.id)))
          .limit(1);

        const isNew = existingConn.length === 0;

        if (!isNew) {
          await db
            .update(facebookConnections)
            .set({
              accessToken: encryptedPageToken,
              pageName: page.name,
              isActive: true,
              facebookAccountId: accountId,
              subscriptionStatus: subscribed ? "active" : "failed",
              subscriptionError: subscriptionError ?? null,
            })
            .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.pageId, page.id)));
        } else {
          await db.insert(facebookConnections).values({
            userId,
            facebookAccountId: accountId,
            pageId: page.id,
            pageName: page.name,
            accessToken: encryptedPageToken,
            isActive: true,
            subscriptionStatus: subscribed ? "active" : "failed",
            subscriptionError: subscriptionError ?? undefined,
          });
        }

        results.push({ pageId: page.id, pageName: page.name, subscribed, isNew, error: subscriptionError });

        // Re-fetch leadgen_forms (non-blocking)
        if (subscribed) {
          upsertFormsForPage({
            userId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: page.access_token,
          }).catch((err) => console.warn(`[FB] Failed to fetch forms for page ${page.id}:`, err));
        }
      }

      const subscribedCount = results.filter((r) => r.subscribed).length;
      const newCount = results.filter((r) => r.isNew).length;
      const failedPages = results.filter((r) => !r.subscribed);

      await log.info("FACEBOOK", "OAuth callback completed successfully", {
        userId,
        fbUserId: profile.id,
        fbUserName: profile.name,
        totalPages: allPages.length,
        subscribedCount,
        newCount,
        failedPages: failedPages.length,
      });

      // ── Step 8: Send success message to opener window ──────────────────────
      res.send(
        renderPopupBridgeHtml(
          {
            type: "fb_oauth_success",
            fbUserName: profile.name,
            fbUserId: profile.id,
            accountId,
            subscribedCount,
            totalPages: allPages.length,
            newCount,
            warnings: failedPages.map((p) => `${p.pageName}: ${p.error}`),
            pages: results,
          },
          "Facebook account connected successfully! You can close this window.",
          "Facebook Connected"
        )
      );
    } catch (error) {
      await log.error("FACEBOOK", "OAuth callback failed", { error: String(error) });
      res.send(
        renderPopupBridgeHtml(
          { type: "fb_oauth_error", error: "Failed to connect Facebook account. Please try again." },
          "Failed to connect Facebook account. Please try again.",
          "Facebook Connection Failed"
        )
      );
    }
  });
}

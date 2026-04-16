/**
 * Facebook Login via Authorization Code Flow (server-side).
 *
 * Separate from the Connection OAuth flow (/api/auth/facebook/callback)
 * which handles page subscriptions and business permissions.
 *
 * This flow only needs email + public_profile for user authentication.
 *
 * Routes:
 *   GET /api/auth/facebook/login          — generate OAuth URL (no auth required)
 *   GET /api/auth/facebook/login/callback  — exchange code, create/find user, set session
 */

import type { Express, Request, Response } from "express";
import axios from "axios";
import { getDb } from "../db";
import { users, facebookAccounts, facebookOauthStates } from "../../drizzle/schema";
import { eq, and, lt } from "drizzle-orm";
import { log } from "../services/appLogger";
import { exchangeCodeForToken } from "../services/facebookGraphService";
import { ENV } from "../_core/env";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, SESSION_EXPIRATION_MS } from "@shared/const";

const FB_LOGIN_CALLBACK_PATH = "/api/auth/facebook/login/callback";

function getLoginCallbackUrl(req: Request): string {
  const forwardedProto = (
    Array.isArray(req.headers["x-forwarded-proto"])
      ? req.headers["x-forwarded-proto"][0]
      : req.headers["x-forwarded-proto"]?.split(",")[0]
  )?.trim();
  const forwardedHost = (
    Array.isArray(req.headers["x-forwarded-host"])
      ? req.headers["x-forwarded-host"][0]
      : req.headers["x-forwarded-host"]?.split(",")[0]
  )?.trim();

  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.headers.host;

  if (protocol && host) return `${protocol}://${host}${FB_LOGIN_CALLBACK_PATH}`;

  if (ENV.appUrl) {
    try {
      return `${new URL(ENV.appUrl).origin}${FB_LOGIN_CALLBACK_PATH}`;
    } catch { /* fall through */ }
  }
  return FB_LOGIN_CALLBACK_PATH;
}

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function registerFacebookLoginRoutes(app: Express): void {
  // ── Initiate login OAuth ────────────────────────────────────────────────────
  app.get("/api/auth/facebook/login", async (req: Request, res: Response) => {
    try {
      const db = await getDb();
      if (!db) { res.status(500).json({ error: "Database not available" }); return; }

      const appId = ENV.facebookAppId;
      if (!appId) { res.status(500).json({ error: "FACEBOOK_APP_ID not configured" }); return; }

      const state = generateState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // userId=0 indicates this is a login flow (user not yet authenticated)
      await db.insert(facebookOauthStates).values({ state, userId: 0, expiresAt });

      const callbackUrl = getLoginCallbackUrl(req);
      const oauthUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
      oauthUrl.searchParams.set("client_id", appId);
      oauthUrl.searchParams.set("redirect_uri", callbackUrl);
      oauthUrl.searchParams.set("scope", "email,public_profile");
      oauthUrl.searchParams.set("state", state);
      oauthUrl.searchParams.set("response_type", "code");
      oauthUrl.searchParams.set("display", "popup");

      res.json({ oauthUrl: oauthUrl.toString() });
    } catch (error) {
      await log.error("FACEBOOK", "Failed to initiate login OAuth", { error: String(error) });
      res.status(500).json({ error: "Failed to initiate Facebook login" });
    }
  });

  // ── Login OAuth Callback ────────────────────────────────────────────────────
  app.get(FB_LOGIN_CALLBACK_PATH, async (req: Request, res: Response) => {
    const code = req.query["code"] as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    const closeWithError = (msg: string) => {
      res.send(`<!DOCTYPE html><html><head><title>Login</title></head><body>
        <script>
          try { var bc = new BroadcastChannel("targenix_fb_login"); bc.postMessage({ type:"fb_login_error", error:${JSON.stringify(msg)} }); bc.close(); } catch(e){}
          try { if(window.opener) window.opener.postMessage({ type:"fb_login_error", error:${JSON.stringify(msg)} }, window.location.origin); } catch(e){}
          window.close();
        </script><p>${msg}</p></body></html>`);
    };

    const closeWithSuccess = () => {
      res.send(`<!DOCTYPE html><html><head><title>Login</title></head><body>
        <script>
          try { var bc = new BroadcastChannel("targenix_fb_login"); bc.postMessage({ type:"fb_login_success" }); bc.close(); } catch(e){}
          try { if(window.opener) window.opener.postMessage({ type:"fb_login_success" }, window.location.origin); } catch(e){}
          window.close();
        </script><p>Logged in! You can close this window.</p></body></html>`);
    };

    if (errorParam) {
      await log.warn("FACEBOOK", "User denied login", { error: errorParam });
      closeWithError("Facebook login cancelled.");
      return;
    }

    if (!code || !stateParam) {
      closeWithError("Invalid callback parameters.");
      return;
    }

    try {
      const db = await getDb();
      if (!db) { closeWithError("Database not available."); return; }

      // CSRF check
      const [savedState] = await db
        .select()
        .from(facebookOauthStates)
        .where(eq(facebookOauthStates.state, stateParam))
        .limit(1);

      if (!savedState || new Date() > savedState.expiresAt) {
        if (savedState) await db.delete(facebookOauthStates).where(eq(facebookOauthStates.id, savedState.id));
        closeWithError("Session expired. Please try again.");
        return;
      }

      await db.delete(facebookOauthStates).where(eq(facebookOauthStates.id, savedState.id));

      const appId = ENV.facebookAppId;
      const appSecret = ENV.facebookAppSecret;
      if (!appId || !appSecret) { closeWithError("Facebook credentials not configured."); return; }

      const callbackUrl = getLoginCallbackUrl(req);

      // Exchange code for token
      const accessToken = await exchangeCodeForToken(code, appId, appSecret, callbackUrl);

      // Get user profile with email
      let fbProfile: { id: string; name?: string; email?: string };
      try {
        const { data } = await axios.get("https://graph.facebook.com/v21.0/me", {
          params: { fields: "id,name,email", access_token: accessToken },
          timeout: 10_000,
        });
        fbProfile = data;
      } catch {
        closeWithError("Failed to verify Facebook token.");
        return;
      }

      if (!fbProfile.id) { closeWithError("Invalid Facebook profile."); return; }

      const fbOpenId = `fb:${fbProfile.id}`;
      const fbEmail = fbProfile.email?.toLowerCase();

      // Find user by openId
      let [user] = await db.select().from(users).where(eq(users.openId, fbOpenId)).limit(1);

      // Find via facebookAccounts
      if (!user) {
        const [fbAccount] = await db
          .select({ userId: facebookAccounts.userId })
          .from(facebookAccounts)
          .where(eq(facebookAccounts.fbUserId, fbProfile.id))
          .limit(1);
        if (fbAccount) {
          [user] = await db.select().from(users).where(eq(users.id, fbAccount.userId)).limit(1);
        }
      }

      // Find by email
      if (!user && fbEmail) {
        [user] = await db.select().from(users).where(eq(users.email, fbEmail)).limit(1);
      }

      // Create new user
      if (!user) {
        await db.insert(users).values({
          openId: fbOpenId,
          email: fbEmail ?? null,
          name: fbProfile.name ?? null,
          loginMethod: "facebook",
          lastSignedIn: new Date(),
        });
        [user] = await db.select().from(users).where(eq(users.openId, fbOpenId)).limit(1);
      }

      if (!user) { closeWithError("Failed to create account."); return; }

      await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

      // Create session
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name ?? "",
        expiresInMs: SESSION_EXPIRATION_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: SESSION_EXPIRATION_MS });

      await log.info("FACEBOOK", "User logged in via Facebook OAuth", {
        userId: user.id,
        fbId: fbProfile.id,
        isNew: !user.lastSignedIn,
      });

      closeWithSuccess();
    } catch (error) {
      await log.error("FACEBOOK", "Login callback failed", { error: String(error) });
      closeWithError("Login failed. Please try again.");
    }
  });

  // Cleanup expired states periodically (non-blocking)
  setInterval(async () => {
    try {
      const db = await getDb();
      if (db) await db.delete(facebookOauthStates).where(lt(facebookOauthStates.expiresAt, new Date()));
    } catch { /* ignore */ }
  }, 60 * 60 * 1000);
}

/**
 * Universal OAuth — GET /api/oauth/:provider/initiate, GET /api/oauth/:provider/callback
 * Google: replaces legacy /api/auth/google/*; login does not use google_accounts.
 */
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { getSessionCookieOptions } from "../_core/cookies";
import { COOKIE_NAME, SESSION_EXPIRATION_MS } from "@shared/const";
import { log } from "../services/appLogger";
import { getGoogleUserProfile, computeExpiryDate } from "../services/googleService";
import { upsertGoogleConnection } from "../services/connectionService";
import { getProvider } from "../oauth/registry";
import { GOOGLE_OAUTH_NAME } from "../oauth/providers/google.provider";
import {
  generateOAuthStateToken,
  insertOAuthState,
  consumeOAuthState,
  scheduleCleanupExpiredStates,
} from "../oauth/stateService";
import { upsertGoogleSheetsIntegrationToken } from "../oauth/tokenService";
import type { OAuthMode } from "../oauth/types";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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

function parseMode(raw: unknown): OAuthMode {
  if (raw === "login" || raw === "integration") return raw;
  return "integration";
}

function loginChannel() {
  return "targenix_google_login" as const;
}
function integrationChannel() {
  return "targenix_google_oauth" as const;
}

function loginPayloadErr(msg: string) {
  return { type: "google_login_error" as const, error: msg };
}
function integrationPayloadErr(msg: string) {
  return { type: "google_oauth_error" as const, error: msg };
}

export function registerOAuthRoutes(app: Express): void {
  app.get("/api/oauth/:provider/initiate", async (req: Request, res: Response) => {
    const providerName = (req.params["provider"] as string) ?? "";
    const spec = getProvider(providerName);
    if (!spec) {
      res.status(404).json({ error: "Unknown OAuth provider" });
      return;
    }
    if (spec.name === GOOGLE_OAUTH_NAME) {
      try {
        const mode = parseMode(req.query["mode"]);
        if (mode === "integration") {
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
          const state = generateOAuthStateToken();
          await insertOAuthState(db, {
            state,
            userId: user.id,
            provider: spec.name,
            mode,
            appKey: spec.integrationAppKey,
          });
          scheduleCleanupExpiredStates(Promise.resolve(db));
          res.json({ oauthUrl: spec.buildAuthorizeUrl(state, mode) });
          return;
        }

        const db = await getDb();
        if (!db) {
          res.status(500).json({ error: "Database not available" });
          return;
        }
        const state = generateOAuthStateToken();
        await insertOAuthState(db, {
          state,
          userId: 0,
          provider: spec.name,
          mode: "login",
          appKey: null,
        });
        scheduleCleanupExpiredStates(Promise.resolve(db));
        res.json({ oauthUrl: spec.buildAuthorizeUrl(state, "login") });
      } catch (error) {
        await log.error("GOOGLE", "oauth initiate error", { error: String(error), provider: spec.name });
        res.status(500).json({ error: "Failed to start OAuth" });
      }
      return;
    }
    res.status(501).json({ error: "Provider not implemented" });
  });

  app.get("/api/oauth/:provider/callback", async (req: Request, res: Response) => {
    const providerName = (req.params["provider"] as string) ?? "";
    const spec = getProvider(providerName);
    if (!spec) {
      res
        .status(404)
        .send(
          popupHtml("targenix_google_login", loginPayloadErr("Unknown OAuth provider"), "Error"),
        );
      return;
    }

    const code = req.query["code"] as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    if (errorParam) {
      res.send(
        popupHtml("targenix_google_login", loginPayloadErr("Access denied"), "Cancelled"),
      );
      return;
    }

    if (!code || !stateParam) {
      res
        .status(400)
        .send(
          popupHtml("targenix_google_login", loginPayloadErr("Missing parameters"), "Error"),
        );
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res
          .status(500)
          .send(
            popupHtml("targenix_google_login", loginPayloadErr("Database unavailable"), "Error"),
          );
        return;
      }

      const saved = await consumeOAuthState(db, stateParam);
      if (!saved) {
        res
          .status(403)
          .send(
            popupHtml("targenix_google_login", loginPayloadErr("CSRF check failed"), "Error"),
          );
        return;
      }

      if (saved.provider !== spec.name) {
        res
          .status(403)
          .send(
            popupHtml("targenix_google_login", loginPayloadErr("Invalid state"), "Error"),
          );
        return;
      }

      const { userId: stateUserId, mode: flowType } = saved;
      const channel = flowType === "login" ? loginChannel() : integrationChannel();

      let exchanged;
      try {
        exchanged = await spec.exchangeCode(db, code);
      } catch (error) {
        await log.error("GOOGLE", "oauth token exchange failed", { error: String(error), flowType });
        res.send(
          popupHtml(
            channel,
            flowType === "login" ? loginPayloadErr("Token exchange failed") : integrationPayloadErr("Token exchange failed"),
            "Error",
          ),
        );
        return;
      }

      const { accessToken, refreshToken, expiresIn, scope: scopeStr } = exchanged;
      const expiryDate = computeExpiryDate(expiresIn);

      let profile;
      try {
        profile = await getGoogleUserProfile(accessToken);
      } catch (error) {
        await log.error("GOOGLE", "oauth profile fetch failed", { error: String(error), flowType });
        res.send(
          popupHtml(
            channel,
            flowType === "login" ? loginPayloadErr("Failed to fetch Google profile") : integrationPayloadErr("Failed to fetch Google profile"),
            "Error",
          ),
        );
        return;
      }

      if (spec.name === GOOGLE_OAUTH_NAME && flowType === "integration") {
        if (!stateUserId || stateUserId <= 0) {
          res
            .status(403)
            .send(
              popupHtml(
                channel,
                integrationPayloadErr("Integration requires an authenticated user"),
                "Error",
              ),
            );
          return;
        }

        const email = profile.email;
        const oauthTokenId = await upsertGoogleSheetsIntegrationToken({
          userId: stateUserId,
          email: email.toLowerCase(),
          name: profile.name ?? "",
          picture: profile.picture ?? "",
          accessToken,
          refreshToken,
          expiryDate,
          scopes: scopeStr,
        });

        let connectionId: number | null = null;
        try {
          connectionId = await upsertGoogleConnection(db, {
            userId: stateUserId,
            oauthTokenId,
            email,
            displayName: profile.name?.trim() ? `${profile.name} (${email})` : email,
          });
        } catch (err) {
          await log.warn("GOOGLE", "oauth connections row upsert failed (non-fatal)", {
            userId: stateUserId,
            oauthTokenId,
            error: String(err),
          });
        }

        await log.info("GOOGLE", "google integration connected (oauth_tokens)", {
          userId: stateUserId,
          email,
          oauthTokenId,
          connectionId,
        });

        res.send(
          popupHtml(
            channel,
            {
              type: "google_oauth_success" as const,
              accountId: oauthTokenId,
              email: profile.email,
              name: profile.name,
              picture: profile.picture,
              scopes: scopeStr,
            },
            "Connected",
          ),
        );
        return;
      }

      if (spec.name === GOOGLE_OAUTH_NAME && flowType === "login") {
        const googleOpenId = `google:${profile.id}`;
        const email = profile.email.toLowerCase();

        let [user] = await db.select().from(users).where(eq(users.openId, googleOpenId)).limit(1);
        if (!user) {
          [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        }

        if (!user) {
          await db.insert(users).values({
            openId: googleOpenId,
            email,
            name: profile.name ?? null,
            loginMethod: "google",
            lastSignedIn: new Date(),
          });
          [user] = await db.select().from(users).where(eq(users.openId, googleOpenId)).limit(1);
        }

        if (!user) {
          res.send(
            popupHtml(channel, loginPayloadErr("Failed to create account"), "Error"),
          );
          return;
        }

        await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

        const sessionToken = await sdk.createSessionToken(user.openId, {
          name: user.name ?? "",
          expiresInMs: SESSION_EXPIRATION_MS,
        });
        res.cookie(COOKIE_NAME, sessionToken, {
          ...getSessionCookieOptions(req),
          maxAge: SESSION_EXPIRATION_MS,
        });

        await log.info("GOOGLE", "user logged in via Google (universal OAuth)", { userId: user.id, email });
        res.send(
          popupHtml(
            channel,
            { type: "google_login_success" as const },
            "Logged In",
          ),
        );
        return;
      }

      res
        .status(501)
        .send(
          popupHtml("targenix_google_login", loginPayloadErr("Provider not implemented"), "Error"),
        );
    } catch (error) {
      await log.error("GOOGLE", "oauth callback unexpected error", { error: String(error) });
      res.send(
        popupHtml("targenix_google_login", loginPayloadErr("Unexpected error"), "Error"),
      );
    }
  });
}

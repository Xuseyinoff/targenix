/**
 * Universal OAuth — GET /api/oauth/:provider/initiate, GET /api/oauth/:provider/callback
 *
 * Google:          static provider (registered at boot) — login + integration modes.
 * Generic OAuth2:  DB-driven provider (apps.oauthConfig) — integration mode only.
 *
 * The Google path is 100% unchanged from the previous implementation.
 * New providers require zero code: insert a row into `apps` with authType='oauth2'
 * and a populated oauthConfig JSON, then call /api/oauth/<appKey>/initiate.
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
import { upsertGoogleConnection, upsertOAuthConnection } from "../services/connectionService";
import { GOOGLE_OAUTH_NAME } from "../oauth/providers/google.provider";
import {
  generateOAuthStateToken,
  insertOAuthState,
  consumeOAuthState,
  scheduleCleanupExpiredStates,
} from "../oauth/stateService";
import { upsertGoogleSheetsIntegrationToken } from "../oauth/tokenService";
import { upsertOAuthIntegrationToken, syntheticOAuthEmail } from "../oauth/genericTokenService";
import { resolveProvider } from "../oauth/resolveProvider";
import { fetchUserProfile } from "../oauth/providers/generic.provider";
import type { OAuthMode } from "../oauth/types";

// ─── HTML popup helpers ───────────────────────────────────────────────────────

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

// ─── Channel / payload helpers ────────────────────────────────────────────────

function parseMode(raw: unknown): OAuthMode {
  if (raw === "login" || raw === "integration") return raw;
  return "integration";
}

// Google channels — kept identical so existing frontend listeners are unaffected.
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

// Generic OAuth2 channels — one per appKey so multiple provider popups don't cross-talk.
function genericOAuthChannel(appKey: string): string {
  return `targenix_oauth_${appKey}`;
}
function genericErrPayload(msg: string) {
  return { type: "oauth_integration_error" as const, error: msg };
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerOAuthRoutes(app: Express): void {

  // ── GET /api/oauth/:provider/initiate ─────────────────────────────────────
  app.get("/api/oauth/:provider/initiate", async (req: Request, res: Response) => {
    const providerName = (req.params["provider"] as string) ?? "";

    try {
      const db = await getDb();
      const spec = await resolveProvider(providerName, db);

      if (!spec) {
        res.status(404).json({ error: "Unknown OAuth provider" });
        return;
      }

      if (!db) {
        res.status(500).json({ error: "Database not available" });
        return;
      }

      // ── Google: existing logic (login + integration) ─────────────────────
      if (spec.name === GOOGLE_OAUTH_NAME) {
        const mode = parseMode(req.query["mode"]);

        if (mode === "integration") {
          const user = await sdk.authenticateRequest(req);
          if (!user) {
            res.status(401).json({ error: "Authentication required" });
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

        // Login mode
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
        return;
      }

      // ── Generic OAuth2: integration mode only ─────────────────────────────
      const user = await sdk.authenticateRequest(req);
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const state = generateOAuthStateToken();
      await insertOAuthState(db, {
        state,
        userId: user.id,
        provider: spec.name,
        mode: "integration",
        appKey: spec.integrationAppKey,
      });
      scheduleCleanupExpiredStates(Promise.resolve(db));
      res.json({ oauthUrl: spec.buildAuthorizeUrl(state, "integration") });
    } catch (error) {
      await log.error("OAUTH", "initiate error", { error: String(error), provider: providerName });
      res.status(500).json({ error: "Failed to start OAuth" });
    }
  });

  // ── GET /api/oauth/:provider/callback ─────────────────────────────────────
  app.get("/api/oauth/:provider/callback", async (req: Request, res: Response) => {
    const providerName = (req.params["provider"] as string) ?? "";

    const code = req.query["code"] as string | undefined;
    const stateParam = req.query["state"] as string | undefined;
    const errorParam = req.query["error"] as string | undefined;

    // Safe error channel before we know which provider this is.
    const earlyErrChannel =
      providerName === "google" ? loginChannel() : genericOAuthChannel(providerName);

    if (errorParam) {
      res.send(popupHtml(earlyErrChannel, loginPayloadErr("Access denied"), "Cancelled"));
      return;
    }
    if (!code || !stateParam) {
      res.status(400).send(
        popupHtml(earlyErrChannel, loginPayloadErr("Missing parameters"), "Error"),
      );
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res
          .status(500)
          .send(popupHtml(earlyErrChannel, loginPayloadErr("Database unavailable"), "Error"));
        return;
      }

      const spec = await resolveProvider(providerName, db);
      if (!spec) {
        res
          .status(404)
          .send(popupHtml(earlyErrChannel, loginPayloadErr("Unknown OAuth provider"), "Error"));
        return;
      }

      const saved = await consumeOAuthState(db, stateParam);
      if (!saved) {
        res
          .status(403)
          .send(popupHtml(earlyErrChannel, loginPayloadErr("CSRF check failed"), "Error"));
        return;
      }
      if (saved.provider !== spec.name) {
        res
          .status(403)
          .send(popupHtml(earlyErrChannel, loginPayloadErr("Invalid state"), "Error"));
        return;
      }

      const { userId: stateUserId, mode: flowType } = saved;

      // ── Code exchange (shared by all providers) ──────────────────────────
      let exchanged: Awaited<ReturnType<typeof spec.exchangeCode>>;
      try {
        exchanged = await spec.exchangeCode(db, code);
      } catch (error) {
        await log.error("OAUTH", "token exchange failed", {
          error: String(error),
          provider: providerName,
          flowType,
        });
        const ch =
          spec.name === GOOGLE_OAUTH_NAME
            ? flowType === "login"
              ? loginChannel()
              : integrationChannel()
            : genericOAuthChannel(spec.integrationAppKey);
        const pay =
          spec.name === GOOGLE_OAUTH_NAME
            ? flowType === "login"
              ? loginPayloadErr("Token exchange failed")
              : integrationPayloadErr("Token exchange failed")
            : genericErrPayload("Token exchange failed");
        res.send(popupHtml(ch, pay, "Error"));
        return;
      }

      const { accessToken, refreshToken, expiresIn, scope: scopeStr } = exchanged;
      const expiryDate = computeExpiryDate(expiresIn);

      // ── Google: EXACT original logic — zero changes ──────────────────────
      if (spec.name === GOOGLE_OAUTH_NAME) {
        const channel = flowType === "login" ? loginChannel() : integrationChannel();

        let profile: Awaited<ReturnType<typeof getGoogleUserProfile>>;
        try {
          profile = await getGoogleUserProfile(accessToken);
        } catch (error) {
          await log.error("GOOGLE", "oauth profile fetch failed", {
            error: String(error),
            flowType,
          });
          res.send(
            popupHtml(
              channel,
              flowType === "login"
                ? loginPayloadErr("Failed to fetch Google profile")
                : integrationPayloadErr("Failed to fetch Google profile"),
              "Error",
            ),
          );
          return;
        }

        if (flowType === "integration") {
          if (!stateUserId || stateUserId <= 0) {
            res.status(403).send(
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

        if (flowType === "login") {
          const googleOpenId = `google:${profile.id}`;
          const email = profile.email.toLowerCase();

          let [user] = await db
            .select()
            .from(users)
            .where(eq(users.openId, googleOpenId))
            .limit(1);
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
            [user] = await db
              .select()
              .from(users)
              .where(eq(users.openId, googleOpenId))
              .limit(1);
          }

          if (!user) {
            res.send(popupHtml(channel, loginPayloadErr("Failed to create account"), "Error"));
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

          await log.info("GOOGLE", "user logged in via Google (universal OAuth)", {
            userId: user.id,
            email,
          });
          res.send(
            popupHtml(channel, { type: "google_login_success" as const }, "Logged In"),
          );
          return;
        }

        res
          .status(501)
          .send(popupHtml(channel, loginPayloadErr("Unhandled Google flow mode"), "Error"));
        return;
      }

      // ── Generic OAuth2 integration ─────────────────────────────────────────
      // Non-Google providers support integration mode only (no session login).
      const genericChannel = genericOAuthChannel(spec.integrationAppKey);

      if (flowType !== "integration" || !stateUserId || stateUserId <= 0) {
        res.status(403).send(
          popupHtml(
            genericChannel,
            genericErrPayload("Integration requires an authenticated user"),
            "Error",
          ),
        );
        return;
      }

      // Optional profile fetch for email deduplication and display name.
      // Falls back to a synthetic email when provider has no userInfoUrl.
      let email: string;
      let displayName: string | undefined;
      try {
        const cfg = await spec.getConfig(db);
        if (cfg.userInfoUrl) {
          const profile = await fetchUserProfile(cfg.userInfoUrl, accessToken);
          email = profile?.email ?? syntheticOAuthEmail(stateUserId, spec.integrationAppKey);
          displayName = profile?.name ?? profile?.email ?? spec.integrationAppKey;
        } else {
          email = syntheticOAuthEmail(stateUserId, spec.integrationAppKey);
          displayName = spec.integrationAppKey;
        }
      } catch (err) {
        await log.warn("OAUTH", "generic profile fetch failed (non-fatal, using synthetic email)", {
          provider: providerName,
          error: String(err),
        });
        email = syntheticOAuthEmail(stateUserId, spec.integrationAppKey);
        displayName = spec.integrationAppKey;
      }

      const oauthTokenId = await upsertOAuthIntegrationToken(db, {
        userId: stateUserId,
        appKey: spec.integrationAppKey,
        email,
        name: displayName,
        accessToken,
        refreshToken,
        expiresIn,
        scopes: scopeStr,
      });

      let connectionId: number | null = null;
      try {
        connectionId = await upsertOAuthConnection(db, {
          userId: stateUserId,
          appKey: spec.integrationAppKey,
          oauthTokenId,
          displayName: displayName ?? spec.integrationAppKey,
        });
      } catch (err) {
        await log.warn("OAUTH", "generic connection row upsert failed (non-fatal)", {
          provider: providerName,
          userId: stateUserId,
          oauthTokenId,
          error: String(err),
        });
      }

      await log.info("OAUTH", "generic oauth2 integration connected", {
        provider: providerName,
        appKey: spec.integrationAppKey,
        userId: stateUserId,
        email,
        oauthTokenId,
        connectionId,
      });

      res.send(
        popupHtml(genericChannel, {
          type: "oauth_integration_success" as const,
          appKey: spec.integrationAppKey,
          connectionId,
          oauthTokenId,
          email,
          displayName,
          scopes: scopeStr,
        }, "Connected"),
      );
    } catch (error) {
      await log.error("OAUTH", "callback unexpected error", {
        error: String(error),
        provider: providerName,
      });
      const fallbackChannel =
        providerName === "google" ? loginChannel() : genericOAuthChannel(providerName);
      res.send(popupHtml(fallbackChannel, loginPayloadErr("Unexpected error"), "Error"));
    }
  });
}

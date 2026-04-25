/**
 * Generic OAuth2 provider — built entirely from apps.oauthConfig.
 * No provider-specific code: one factory covers any OAuth2-compliant service.
 *
 * Config fields (stored in apps.oauthConfig JSON):
 *   authorizeUrl        required   Authorization endpoint
 *   tokenUrl            required   Token exchange / refresh endpoint
 *   clientId            optional*  Direct value
 *   clientIdEnv         optional*  Env var name holding the client ID
 *   clientSecret        optional*  Direct value (acceptable for admin-only configs)
 *   clientSecretEnv     optional*  Env var name holding the client secret
 *   scopes              optional   Array of scope strings
 *   redirectUri         optional   Full callback URL; derived from APP_BASE_URL if absent
 *   extraParams         optional   Extra authorize-URL params (access_type, prompt, …)
 *   userInfoUrl         optional   GET endpoint for identity (email deduplication)
 *   userInfoEmailField  optional   JSON key for email in userInfo response (default "email")
 *   userInfoNameField   optional   JSON key for name in userInfo response (default "name")
 *
 * * At least one of (clientId | clientIdEnv) and one of (clientSecret | clientSecretEnv) must be set.
 */

import axios from "axios";
import type { DbClient } from "../../db";
import type {
  OAuthCodeExchange,
  OAuthMode,
  OAuthProviderSpec,
  RefreshAccessTokenResult,
} from "../types";

// ─── Config shape (stored in apps.oauthConfig) ────────────────────────────────

export type GenericOAuthConfigJson = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientIdEnv?: string;
  clientSecret?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  redirectUri?: string;
  extraParams?: Record<string, string>;
  userInfoUrl?: string;
  userInfoEmailField?: string;
  userInfoNameField?: string;
};

export type OAuthUserProfile = {
  email: string;
  name?: string;
  picture?: string;
};

// ─── Credential / URL resolution helpers ─────────────────────────────────────

function resolveClientId(cfg: GenericOAuthConfigJson): string {
  if (cfg.clientId) return cfg.clientId;
  if (cfg.clientIdEnv) {
    const v = process.env[cfg.clientIdEnv];
    if (v) return v;
    throw new Error(`Env var '${cfg.clientIdEnv}' is not set (clientIdEnv for generic OAuth)`);
  }
  throw new Error("Generic OAuth config is missing clientId / clientIdEnv");
}

function resolveClientSecret(cfg: GenericOAuthConfigJson): string {
  if (cfg.clientSecret) return cfg.clientSecret;
  if (cfg.clientSecretEnv) {
    const v = process.env[cfg.clientSecretEnv];
    if (v) return v;
    throw new Error(`Env var '${cfg.clientSecretEnv}' is not set (clientSecretEnv for generic OAuth)`);
  }
  throw new Error("Generic OAuth config is missing clientSecret / clientSecretEnv");
}

/**
 * Derive the redirect URI:
 *   1. Explicit `redirectUri` in config (recommended).
 *   2. Replace the `/google/callback` segment in GOOGLE_CALLBACK_URL (same host).
 *   3. `${APP_BASE_URL}/api/oauth/${providerName}/callback`.
 *   4. Throw — operator must set one of the above.
 */
function resolveRedirectUri(cfg: GenericOAuthConfigJson, providerName: string): string {
  if (cfg.redirectUri) return cfg.redirectUri;

  const googleCb = process.env.GOOGLE_CALLBACK_URL;
  if (googleCb && /\/google\/callback$/.test(googleCb)) {
    return googleCb.replace(/\/google\/callback$/, `/${providerName}/callback`);
  }

  const base = process.env.APP_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/api/oauth/${providerName}/callback`;

  throw new Error(
    `Cannot determine redirect URI for provider '${providerName}'. ` +
      "Set redirectUri in apps.oauthConfig, or set APP_BASE_URL env var.",
  );
}

// ─── User-profile fetch ───────────────────────────────────────────────────────

/**
 * Fetch a user profile from an arbitrary userInfo endpoint.
 */
export async function fetchUserProfile(
  userInfoUrl: string,
  accessToken: string,
  emailField = "email",
  nameField = "name",
): Promise<OAuthUserProfile | null> {
  const res = await axios.get<Record<string, unknown>>(userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 8_000,
  });

  const data = res.data;
  const email = typeof data[emailField] === "string" ? (data[emailField] as string) : null;
  if (!email) return null;

  return {
    email,
    name: typeof data[nameField] === "string" ? (data[nameField] as string) : undefined,
    picture: typeof data["picture"] === "string" ? (data["picture"] as string) : undefined,
  };
}

// ─── Provider factory ─────────────────────────────────────────────────────────

/**
 * Build an OAuthProviderSpec for any OAuth2-compliant service from its DB config.
 *
 * @param providerName  URL segment used in /api/oauth/:provider/* routes (usually == appKey).
 * @param appKey        apps.appKey — stored in oauth_tokens.appKey and connections.appKey.
 * @param rawConfig     Parsed apps.oauthConfig JSON.
 */
export function buildGenericProvider(
  providerName: string,
  appKey: string,
  rawConfig: GenericOAuthConfigJson,
): OAuthProviderSpec {
  return {
    name: providerName,
    integrationAppKey: appKey,

    async getConfig(_db: DbClient | null) {
      return {
        authorizeUrl: rawConfig.authorizeUrl,
        tokenUrl: rawConfig.tokenUrl,
        clientId: resolveClientId(rawConfig),
        clientSecret: resolveClientSecret(rawConfig),
        scopes: rawConfig.scopes ?? [],
        redirectUri: resolveRedirectUri(rawConfig, providerName),
        userInfoUrl: rawConfig.userInfoUrl,
        extraParams: rawConfig.extraParams,
      };
    },

    buildAuthorizeUrl(state: string, _mode: OAuthMode): string {
      const url = new URL(rawConfig.authorizeUrl);
      url.searchParams.set("client_id", resolveClientId(rawConfig));
      url.searchParams.set("redirect_uri", resolveRedirectUri(rawConfig, providerName));
      url.searchParams.set("response_type", "code");
      if (rawConfig.scopes?.length) {
        url.searchParams.set("scope", rawConfig.scopes.join(" "));
      }
      url.searchParams.set("state", state);
      for (const [k, v] of Object.entries(rawConfig.extraParams ?? {})) {
        url.searchParams.set(k, v);
      }
      return url.toString();
    },

    async exchangeCode(_db: DbClient | null, code: string): Promise<OAuthCodeExchange> {
      const res = await axios.post<Record<string, unknown>>(
        rawConfig.tokenUrl,
        new URLSearchParams({
          code,
          client_id: resolveClientId(rawConfig),
          client_secret: resolveClientSecret(rawConfig),
          redirect_uri: resolveRedirectUri(rawConfig, providerName),
          grant_type: "authorization_code",
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 },
      );

      const d = res.data;
      if (d["error"]) {
        const oauthError = String(d["error"]);
        const err = new Error(`OAuth token exchange failed: ${oauthError}`);
        (err as Error & { oauthError: string }).oauthError = oauthError;
        throw err;
      }

      return {
        accessToken: String(d["access_token"] ?? ""),
        refreshToken: typeof d["refresh_token"] === "string" ? d["refresh_token"] : undefined,
        expiresIn: typeof d["expires_in"] === "number" ? (d["expires_in"] as number) : 3600,
        scope:
          typeof d["scope"] === "string"
            ? (d["scope"] as string)
            : (rawConfig.scopes ?? []).join(" "),
      };
    },

    async refreshAccessToken(
      _db: DbClient | null,
      refreshTokenPlain: string,
    ): Promise<RefreshAccessTokenResult> {
      const res = await axios.post<Record<string, unknown>>(
        rawConfig.tokenUrl,
        new URLSearchParams({
          refresh_token: refreshTokenPlain,
          client_id: resolveClientId(rawConfig),
          client_secret: resolveClientSecret(rawConfig),
          grant_type: "refresh_token",
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 },
      );

      const d = res.data;
      if (d["error"]) {
        const oauthError = String(d["error"]);
        const err = new Error(`OAuth refresh failed: ${oauthError}`);
        (err as Error & { oauthError: string }).oauthError = oauthError;
        // Caller sees oauthError='invalid_grant' and should mark the connection expired.
        throw err;
      }

      return {
        accessToken: String(d["access_token"] ?? ""),
        expiresIn: typeof d["expires_in"] === "number" ? (d["expires_in"] as number) : 3600,
      };
    },
  };
}

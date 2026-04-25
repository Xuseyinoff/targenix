import axios from "axios";
import { getGoogleSheetsOAuthConfig, GOOGLE_SHEETS_APP_KEY } from "../getOAuthConfig";
import type { DbClient } from "../../db";
import type { OAuthCodeExchange, OAuthMode, OAuthProviderSpec } from "../types";
import { buildGoogleAuthUrl, type GoogleTokenResponse } from "../../services/googleService";

export const GOOGLE_OAUTH_NAME = "google" as const;

/**
 * Google OAuth: authorize URL and token exchange use `getGoogleCallbackUrl()`,
 * `getGoogleClientId` / `getGoogleClientSecret`, and optional `apps.oauthConfig` URLs.
 */
export const googleProvider: OAuthProviderSpec = {
  name: GOOGLE_OAUTH_NAME,
  integrationAppKey: GOOGLE_SHEETS_APP_KEY,
  getConfig: getGoogleSheetsOAuthConfig,
  buildAuthorizeUrl(state: string, mode: OAuthMode): string {
    const t = mode === "integration" ? "integration" : "login";
    return buildGoogleAuthUrl(state, t);
  },
  async exchangeCode(db: DbClient | null, code: string): Promise<OAuthCodeExchange> {
    const config = await getGoogleSheetsOAuthConfig(db);
    const response = await axios.post<GoogleTokenResponse>(
      config.tokenUrl,
      new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 },
    );
    const d = response.data;
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresIn: d.expires_in,
      scope: d.scope,
    };
  },
};

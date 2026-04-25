import type { DbClient } from "../db";

/**
 * Resolved OAuth client configuration (secrets from env, URLs from DB or env).
 */
export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
  /** Optional — Google userinfo; other providers may differ. */
  userInfoUrl?: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export type OAuthMode = "login" | "integration";

export type OAuthCodeExchange = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
};

export interface OAuthProviderSpec {
  /** URL segment, e.g. "google" */
  name: string;
  /** apps.appKey for integration (e.g. google-sheets). */
  integrationAppKey: string;
  getConfig(db: DbClient | null): Promise<OAuthConfig>;
  buildAuthorizeUrl(state: string, mode: OAuthMode): string;
  exchangeCode(db: DbClient | null, code: string): Promise<OAuthCodeExchange>;
}

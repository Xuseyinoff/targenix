/**
 * Google OAuth 2.0 helpers.
 *
 * SCOPE POLICY
 * ────────────
 * GOOGLE_LOGIN_SCOPES      — Login / Register only. Never used for API calls.
 * GOOGLE_INTEGRATION_SCOPES — Google Sheets / Drive. Used only for integration accounts.
 *
 * The two flows MUST never share tokens.
 */

import axios from "axios";
import { log } from "./appLogger";

// ─── Google endpoints ─────────────────────────────────────────────────────────

const GOOGLE_TOKEN_URL   = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL  = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_AUTH_URL    = "https://accounts.google.com/o/oauth2/v2/auth";

// ─── Scope sets ───────────────────────────────────────────────────────────────

/**
 * Scopes for Google Login / Register.
 * Identity only — no API access granted.
 */
export const GOOGLE_LOGIN_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/**
 * Scopes for Google Sheets / Drive integration.
 * Includes login scopes (Google requires them) plus API access scopes.
 */
export const GOOGLE_INTEGRATION_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  /** List spreadsheet files in Drive (picker UX); metadata only, not file content. */
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

/** Human-readable scope label — used for display in the UI. */
export const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/userinfo.email":   "Read email address",
  "https://www.googleapis.com/auth/userinfo.profile": "Read profile info",
  "https://www.googleapis.com/auth/spreadsheets":     "Read and write Google Sheets",
  "https://www.googleapis.com/auth/drive.file":       "Access files created by this app",
  "https://www.googleapis.com/auth/drive.metadata.readonly":
    "See names of your Google Sheets in Drive (for picker)",
};

// ─── Config helpers ───────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} environment variable is required`);
  return value;
}

export function getGoogleClientId(): string     { return requireEnv("GOOGLE_CLIENT_ID"); }
export function getGoogleClientSecret(): string { return requireEnv("GOOGLE_CLIENT_SECRET"); }
export function getGoogleCallbackUrl(): string  { return requireEnv("GOOGLE_CALLBACK_URL"); }

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token?: string;
}

export interface GoogleUserProfile {
  id: string;
  email: string;
  name: string;
  picture: string;
  verified_email: boolean;
}

export interface GoogleRefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

// ─── Authorization URL ────────────────────────────────────────────────────────

/**
 * Build the Google OAuth consent-screen URL.
 *
 * @param state  CSRF token stored in DB
 * @param type   "login" = identity only | "integration" = full API access
 */
export function buildGoogleAuthUrl(state: string, type: "login" | "integration"): string {
  const scopes = type === "integration" ? GOOGLE_INTEGRATION_SCOPES : GOOGLE_LOGIN_SCOPES;

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id",     getGoogleClientId());
  url.searchParams.set("redirect_uri",  getGoogleCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         scopes.join(" "));
  url.searchParams.set("state",         state);
  // access_type=offline → refresh_token returned on first consent
  url.searchParams.set("access_type",   "offline");
  // prompt=consent → always ask, ensuring refresh_token is issued each time
  url.searchParams.set("prompt",        "consent");
  return url.toString();
}

// ─── User Profile ─────────────────────────────────────────────────────────────

/**
 * Fetch the authenticated user's Google profile using an access token.
 */
export async function getGoogleUserProfile(accessToken: string): Promise<GoogleUserProfile> {
  await log.info("GOOGLE", "→ getGoogleUserProfile");

  const response = await axios.get<GoogleUserProfile>(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10_000,
  });

  return response.data;
}

// ─── Token Refresh ────────────────────────────────────────────────────────────

/**
 * Use a stored refresh_token to obtain a new access_token.
 */
export async function refreshGoogleToken(refreshToken: string): Promise<GoogleRefreshResponse> {
  await log.info("GOOGLE", "→ refreshGoogleToken");

  const response = await axios.post<GoogleRefreshResponse>(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      client_id:     getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
  );

  return response.data;
}

// ─── Token revocation ─────────────────────────────────────────────────────────

/**
 * Revoke a token at Google's servers (best-effort, never throws).
 */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await axios.post(
      GOOGLE_REVOKE_URL,
      new URLSearchParams({ token }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 5_000 }
    );
  } catch {
    // Revocation is best-effort — token may already be expired or revoked
  }
}

// ─── Expiry helpers ───────────────────────────────────────────────────────────

/**
 * Compute absolute expiry Date from expires_in (seconds).
 * Subtracts a 60-second safety buffer.
 */
export function computeExpiryDate(expiresIn: number): Date {
  return new Date(Date.now() + (expiresIn - 60) * 1000);
}

/**
 * Returns true if the token has expired or will expire within 60 seconds.
 */
export function isTokenExpired(expiryDate: Date | null | undefined): boolean {
  if (!expiryDate) return false;
  return expiryDate.getTime() <= Date.now() + 60_000;
}

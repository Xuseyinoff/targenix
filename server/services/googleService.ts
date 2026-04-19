/**
 * Google OAuth 2.0 helpers.
 *
 * Handles:
 *  - Building the authorization URL
 *  - Exchanging an authorization code for tokens
 *  - Fetching the authenticated user's profile
 *  - Refreshing an expired access token
 *  - Checking whether a stored token is expired
 */

import axios from "axios";
import { log } from "./appLogger";

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** All scopes requested from Google. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

// ─── Config helpers ───────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} environment variable is required`);
  return value;
}

export function getGoogleClientId(): string {
  return requireEnv("GOOGLE_CLIENT_ID");
}

export function getGoogleClientSecret(): string {
  return requireEnv("GOOGLE_CLIENT_SECRET");
}

export function getGoogleCallbackUrl(): string {
  return requireEnv("GOOGLE_CALLBACK_URL");
}

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
 * Build the Google OAuth 2.0 consent-screen URL.
 * `state` is the CSRF token stored in DB.
 */
export function buildGoogleAuthUrl(state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", getGoogleClientId());
  url.searchParams.set("redirect_uri", getGoogleCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  // access_type=offline ensures a refresh_token is returned on first consent
  url.searchParams.set("access_type", "offline");
  // prompt=consent forces Google to return a new refresh_token every time
  // (otherwise it is only issued on first connection)
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

/**
 * Exchange an authorization code (from callback ?code=...) for tokens.
 * Returns access_token, refresh_token, expires_in.
 */
export async function exchangeCodeForGoogleTokens(code: string): Promise<GoogleTokenResponse> {
  await log.info("GOOGLE", "→ exchangeCodeForGoogleTokens");

  const response = await axios.post<GoogleTokenResponse>(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      redirect_uri: getGoogleCallbackUrl(),
      grant_type: "authorization_code",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
  );

  return response.data;
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
 * Throws if the refresh token has been revoked or is invalid.
 */
export async function refreshGoogleToken(refreshToken: string): Promise<GoogleRefreshResponse> {
  await log.info("GOOGLE", "→ refreshGoogleToken");

  const response = await axios.post<GoogleRefreshResponse>(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
  );

  return response.data;
}

// ─── Expiry helpers ───────────────────────────────────────────────────────────

/**
 * Calculate the absolute expiry Date from an expires_in (seconds) value.
 * Subtracts a 60-second safety buffer to refresh slightly before actual expiry.
 */
export function computeExpiryDate(expiresIn: number): Date {
  return new Date(Date.now() + (expiresIn - 60) * 1000);
}

/**
 * Returns true if the token has expired or expires within the next 60 seconds.
 */
export function isTokenExpired(expiryDate: Date | null | undefined): boolean {
  if (!expiryDate) return false; // no expiry info — assume valid
  return expiryDate.getTime() <= Date.now() + 60_000;
}

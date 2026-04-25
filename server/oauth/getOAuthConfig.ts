/**
 * Load OAuth client config: prefer `apps.oauthConfig` JSON, merge with env secrets.
 * For Google, falls back to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL.
 */
import { and, eq } from "drizzle-orm";
import { apps } from "../../drizzle/schema";
import type { DbClient } from "../db";
import {
  getGoogleClientId,
  getGoogleClientSecret,
  getGoogleCallbackUrl,
} from "../services/googleService";
import type { OAuthConfig } from "./types";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";

export const GOOGLE_SHEETS_APP_KEY = "google-sheets";

type OauthConfigJson = {
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  /** If true, still use process.env for client id/secret (DB never holds secrets). */
  useEnvCredentials?: boolean;
};

export async function getGoogleSheetsOAuthConfig(
  db: DbClient | null,
): Promise<OAuthConfig> {
  let json: OauthConfigJson = {};
  if (db) {
    const [row] = await db
      .select({ oauthConfig: apps.oauthConfig })
      .from(apps)
      .where(and(eq(apps.appKey, GOOGLE_SHEETS_APP_KEY), eq(apps.isActive, true)))
      .limit(1);
    if (row?.oauthConfig && typeof row.oauthConfig === "object") {
      json = row.oauthConfig as OauthConfigJson;
    }
  }

  return {
    authorizeUrl: json.authorizeUrl ?? GOOGLE_AUTH,
    tokenUrl: json.tokenUrl ?? GOOGLE_TOKEN,
    userInfoUrl: json.userInfoUrl ?? GOOGLE_USERINFO,
    clientId: getGoogleClientId(),
    clientSecret: getGoogleClientSecret(),
    redirectUri: getGoogleCallbackUrl(),
    scopes: [],
  };
}

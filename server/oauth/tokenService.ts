/**
 * Encrypted storage + refresh for rows in `oauth_tokens` (Google Sheets integration).
 */
import { and, eq } from "drizzle-orm";
import { oauthTokens } from "../../drizzle/schema";
import { getDb } from "../db";
import { encrypt, decrypt } from "../encryption";
import {
  refreshGoogleToken,
  computeExpiryDate,
  isTokenExpired,
} from "../services/googleService";
import { log } from "../services/appLogger";
import { GOOGLE_SHEETS_APP_KEY } from "./getOAuthConfig";

export type UpsertGoogleSheetsTokenInput = {
  userId: number;
  email: string;
  name: string;
  picture: string;
  accessToken: string;
  refreshToken?: string;
  expiryDate: Date;
  scopes: string;
};

/**
 * Upsert by (userId, appKey, email). Returns oauth_tokens.id.
 */
export async function upsertGoogleSheetsIntegrationToken(
  input: UpsertGoogleSheetsTokenInput,
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const encA = encrypt(input.accessToken);
  const encR = input.refreshToken ? encrypt(input.refreshToken) : null;

  const [existing] = await db
    .select({ id: oauthTokens.id, refreshToken: oauthTokens.refreshToken })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, input.userId),
        eq(oauthTokens.appKey, GOOGLE_SHEETS_APP_KEY),
        eq(oauthTokens.email, input.email),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(oauthTokens)
      .set({
        name: input.name,
        picture: input.picture,
        accessToken: encA,
        ...(encR ? { refreshToken: encR } : {}),
        expiryDate: input.expiryDate,
        scopes: input.scopes,
      })
      .where(eq(oauthTokens.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db.insert(oauthTokens).values({
    userId: input.userId,
    appKey: GOOGLE_SHEETS_APP_KEY,
    email: input.email,
    name: input.name,
    picture: input.picture,
    accessToken: encA,
    refreshToken: encR ?? undefined,
    expiryDate: input.expiryDate,
    scopes: input.scopes,
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

/**
 * Valid access token for a Google Sheets integration `oauth_tokens` row.
 * Refreshes via Google token endpoint when expired.
 */
export async function getValidGoogleAccessToken(oauthTokenId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.id, oauthTokenId))
    .limit(1);

  if (!row) throw new Error(`OAuth token ${oauthTokenId} not found`);
  if (row.appKey !== GOOGLE_SHEETS_APP_KEY) {
    throw new Error(`OAuth token ${oauthTokenId} is not a Google Sheets integration token`);
  }

  if (row.expiryDate && !isTokenExpired(row.expiryDate)) {
    return decrypt(row.accessToken);
  }

  if (!row.refreshToken) {
    throw new Error(
      `Integration token ${oauthTokenId} expired and no refresh token. User must reconnect Google.`,
    );
  }

  const refreshed = await refreshGoogleToken(decrypt(row.refreshToken));
  const newExpiry = computeExpiryDate(refreshed.expires_in);

  await db
    .update(oauthTokens)
    .set({ accessToken: encrypt(refreshed.access_token), expiryDate: newExpiry })
    .where(eq(oauthTokens.id, oauthTokenId));

  await log.info("GOOGLE", "google_sheets token refreshed (oauth_tokens)", { oauthTokenId });
  return refreshed.access_token;
}

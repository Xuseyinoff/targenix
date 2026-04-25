/**
 * Generic access token for an `oauth_tokens` row: decrypt if still valid,
 * otherwise refresh via `getProviderByAppKey` and persist.
 */
import { and, eq } from "drizzle-orm";
import { oauthTokens } from "../../drizzle/schema";
import type { DbClient } from "../db";
import { encrypt, decrypt } from "../encryption";
import { computeExpiryDate, isTokenExpired } from "../services/googleService";
import { log } from "../services/appLogger";
import { getProviderByAppKey } from "./registry";

export type GetValidAccessTokenParams = {
  userId: number;
  appKey: string;
  oauthTokenId: number;
};

/**
 * Returns a usable plaintext access token for the given row.
 * @throws Error with message `TOKEN_NOT_FOUND` | `PROVIDER_NOT_FOUND` | `NO_REFRESH_TOKEN`
 */
export async function getValidAccessToken(
  db: DbClient,
  params: GetValidAccessTokenParams,
): Promise<string> {
  const { userId, appKey, oauthTokenId } = params;

  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.id, oauthTokenId),
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.appKey, appKey),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error("TOKEN_NOT_FOUND");
  }

  if (row.expiryDate && !isTokenExpired(row.expiryDate)) {
    return decrypt(row.accessToken);
  }

  const provider = getProviderByAppKey(appKey);
  if (!provider || !provider.refreshAccessToken) {
    throw new Error("PROVIDER_NOT_FOUND");
  }

  if (!row.refreshToken) {
    throw new Error("NO_REFRESH_TOKEN");
  }

  const refreshed = await provider.refreshAccessToken(db, decrypt(row.refreshToken));
  const newExpiry = computeExpiryDate(refreshed.expiresIn);

  await db
    .update(oauthTokens)
    .set({
      accessToken: encrypt(refreshed.accessToken),
      expiryDate: newExpiry,
    })
    .where(eq(oauthTokens.id, oauthTokenId));

  await log.info("GOOGLE", "oauth access token refreshed (getValidAccessToken)", {
    oauthTokenId,
    appKey,
  });

  return refreshed.accessToken;
}

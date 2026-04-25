/**
 * Generic oauth_tokens upsert — works for any OAuth2 provider, not Google-specific.
 * Google Sheets keeps using upsertGoogleSheetsIntegrationToken (tokenService.ts).
 */

import { and, eq } from "drizzle-orm";
import { oauthTokens } from "../../drizzle/schema";
import type { DbClient } from "../db";
import { encrypt } from "../encryption";
import { computeExpiryDate } from "../services/googleService";

export type UpsertOAuthTokenInput = {
  userId: number;
  appKey: string;
  /** Email from userInfo response, or synthetic `user-{userId}@{appKey}.oauth` if provider has no userInfoUrl. */
  email: string;
  name?: string;
  picture?: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes?: string;
};

/**
 * Upsert an oauth_tokens row keyed by (userId, appKey, email).
 * Returns the row id (existing or newly inserted).
 */
export async function upsertOAuthIntegrationToken(
  db: DbClient,
  input: UpsertOAuthTokenInput,
): Promise<number> {
  const encA = encrypt(input.accessToken);
  const encR = input.refreshToken ? encrypt(input.refreshToken) : null;
  const expiryDate = computeExpiryDate(input.expiresIn);

  const [existing] = await db
    .select({ id: oauthTokens.id })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, input.userId),
        eq(oauthTokens.appKey, input.appKey),
        eq(oauthTokens.email, input.email),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(oauthTokens)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.picture !== undefined ? { picture: input.picture } : {}),
        accessToken: encA,
        ...(encR ? { refreshToken: encR } : {}),
        expiryDate,
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      })
      .where(eq(oauthTokens.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db.insert(oauthTokens).values({
    userId: input.userId,
    appKey: input.appKey,
    email: input.email,
    name: input.name ?? null,
    picture: input.picture ?? null,
    accessToken: encA,
    refreshToken: encR ?? undefined,
    expiryDate,
    scopes: input.scopes ?? null,
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

/**
 * Synthetic email used when a provider has no userInfoUrl.
 * Stable per (userId, appKey) so upserts deduplicate correctly.
 */
export function syntheticOAuthEmail(userId: number, appKey: string): string {
  return `user-${userId}@${appKey}.oauth`;
}

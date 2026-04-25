/**
 * Generic access token for an `oauth_tokens` row: decrypt if still valid,
 * otherwise refresh via `resolveProvider` (static registry first, then DB)
 * and persist. Works for Google and any generic OAuth2 provider.
 */
import { and, eq } from "drizzle-orm";
import { oauthTokens } from "../../drizzle/schema";
import type { DbClient } from "../db";
import { encrypt, decrypt } from "../encryption";
import { computeExpiryDate, isTokenExpired } from "../services/googleService";
import { log } from "../services/appLogger";
import { resolveProvider } from "./resolveProvider";
import { incOAuthErrors } from "../monitoring/metrics";
import { markOAuthConnectionExpired } from "../services/connectionService";

const refreshLocks = new Map<string, Promise<string>>();

function isRevokedLikeError(err: unknown): boolean {
  const e = err as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };
  const status = e?.response?.status;
  const msg = String(e?.message ?? "");
  const dataStr = e?.response?.data ? JSON.stringify(e.response.data) : "";
  const hay = `${msg} ${dataStr}`.toLowerCase();
  return (
    status === 400 ||
    status === 401 ||
    hay.includes("invalid_grant") ||
    hay.includes("revoked") ||
    hay.includes("invalid refresh") ||
    hay.includes("unauthorized")
  );
}

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

  // Two-tier provider lookup: static registry first (Google, zero DB hit),
  // then DB lookup for any app with authType='oauth2' and oauthConfig set.
  const provider = await resolveProvider(appKey, db);
  if (!provider || !provider.refreshAccessToken) {
    throw new Error("PROVIDER_NOT_FOUND");
  }

  if (!row.refreshToken) {
    throw new Error("NO_REFRESH_TOKEN");
  }

  const lockKey = `${userId}:${appKey}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;

  const p = (async () => {
    try {
      const refreshed = await provider.refreshAccessToken(db, decrypt(row.refreshToken!));
      const newExpiry = computeExpiryDate(refreshed.expiresIn);

      await db
        .update(oauthTokens)
        .set({
          accessToken: encrypt(refreshed.accessToken),
          expiryDate: newExpiry,
        })
        .where(eq(oauthTokens.id, oauthTokenId));

      await log.info("OAUTH", "oauth access token refreshed (getValidAccessToken)", {
        oauthTokenId,
        appKey,
      });
      return refreshed.accessToken;
    } catch (err) {
      incOAuthErrors(1);
      if (isRevokedLikeError(err)) {
        // Mark ALL connections backed by this oauth_tokens row as expired —
        // covers google_sheets, oauth2, and any future provider types.
        await markOAuthConnectionExpired(db, oauthTokenId);
        console.log({
          stage: "oauth_revoked",
          appKey,
          userId,
          oauthTokenId,
          status: (err as { response?: { status?: number } })?.response?.status,
        });
      }
      throw err;
    } finally {
      refreshLocks.delete(lockKey);
    }
  })();

  refreshLocks.set(lockKey, p);
  return p;
}

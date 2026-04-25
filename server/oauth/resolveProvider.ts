/**
 * resolveProvider — two-tier provider lookup.
 *
 * Tier 1: static in-memory registry (google registered at boot — zero DB round-trips).
 * Tier 2: DB lookup in `apps` for any app with authType='oauth2' and a populated
 *         oauthConfig JSON — builds a GenericOAuthProvider on the fly, no code needed.
 */

import { and, eq } from "drizzle-orm";
import { apps } from "../../drizzle/schema";
import type { DbClient } from "../db";
import type { OAuthProviderSpec } from "./types";
import { getProvider } from "./registry";
import { buildGenericProvider, type GenericOAuthConfigJson } from "./providers/generic.provider";

/**
 * Resolve a provider by URL segment (e.g. "google", "amocrm", "hubspot").
 *
 * Order:
 *   1. Static registry — Google resolves here with zero DB round-trips.
 *   2. DB lookup — any active `apps` row with authType='oauth2' and oauthConfig set
 *      is wired up automatically as a GenericOAuthProvider.
 *
 * Returns undefined when no matching static or DB provider exists.
 */
export async function resolveProvider(
  providerName: string,
  db: DbClient | null,
): Promise<OAuthProviderSpec | undefined> {
  const staticSpec = getProvider(providerName);
  if (staticSpec) return staticSpec;

  if (!db) return undefined;

  const [row] = await db
    .select({ appKey: apps.appKey, oauthConfig: apps.oauthConfig })
    .from(apps)
    .where(and(eq(apps.appKey, providerName), eq(apps.authType, "oauth2"), eq(apps.isActive, true)))
    .limit(1);

  if (!row?.oauthConfig) return undefined;

  const cfg = row.oauthConfig as GenericOAuthConfigJson;
  if (!cfg.authorizeUrl || !cfg.tokenUrl) {
    console.warn(
      `[resolveProvider] app '${providerName}' has authType=oauth2 but oauthConfig is missing authorizeUrl/tokenUrl — skipping.`,
    );
    return undefined;
  }

  return buildGenericProvider(providerName, row.appKey, cfg);
}

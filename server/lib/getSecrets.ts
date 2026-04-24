/**
 * getSecrets — Phase 1 dual-read helper.
 *
 * Single entry-point for resolving decrypted credentials for a destination.
 * Callers receive a plain `Record<string, string>` and never need to know
 * whether secrets came from the new `connections` table or the legacy
 * `templateConfig.secrets` field.
 *
 * Resolution order:
 *   1. `destination.connectionId` is set AND the linked row exists + belongs
 *      to the same tenant AND the row carries a non-empty
 *      `credentialsJson.secretsEncrypted` map
 *      → decrypt and return secrets from the connection. ✅
 *
 *   2. `connectionId` set BUT the linked row is missing or cross-tenant
 *      → throw (loud failure; misconfigured DB state, not a normal case).
 *
 *   3. No `connectionId` → fall back to `templateConfig.secrets`.
 *      Keys are decrypted on the fly and returned. Empty map if not present.
 *
 * Decryption contract:
 *   - Values in both stores are AES-256-CBC ciphertexts produced by
 *     `server/encryption.ts:encrypt()`.
 *   - `decrypt()` throws on key drift or corruption; callers should let it
 *     propagate so the delivery is marked FAILED (retryable) rather than
 *     sending an empty credential.
 *
 * Production safety:
 *   - Does NOT enforce the `USE_CONNECTION_SECRETS_ONLY` feature flag — that
 *     constraint lives in `resolveSecretsForDelivery` (affiliateService.ts)
 *     which is used by the hot delivery path. This helper is intended for
 *     admin endpoints, test-send calls, and future adapters that need the
 *     simpler "give me decrypted secrets" API.
 *   - Never logs plaintext secrets.
 *   - Tenant safety: when loading from `connections`, the row's `userId`
 *     MUST match `destination.userId`. A mismatch throws (never falls back
 *     silently) because a stray FK could otherwise expose another user's
 *     credentials.
 */

import { and, eq } from "drizzle-orm";
import { connections, targetWebsites } from "../../drizzle/schema";
import { decrypt } from "../encryption";
import type { DbClient } from "../db";

export async function getSecrets(
  db: DbClient,
  destination: typeof targetWebsites.$inferSelect,
): Promise<Record<string, string>> {
  // ── PATH 1: connection-backed secrets ──────────────────────────────────────
  if (destination.connectionId) {
    const [conn] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, destination.connectionId),
          eq(connections.userId, destination.userId), // TENANT SAFE
        ),
      )
      .limit(1);

    if (!conn) {
      throw new Error(
        `Connection ${destination.connectionId} not found for destination ${destination.id} (userId=${destination.userId})`,
      );
    }

    const creds = (conn.credentialsJson ?? {}) as {
      secretsEncrypted?: Record<string, string>;
    };

    const decrypted: Record<string, string> = {};
    for (const [key, encVal] of Object.entries(creds.secretsEncrypted ?? {})) {
      decrypted[key] = decrypt(encVal);
    }
    return decrypted;
  }

  // ── PATH 2: legacy fallback — templateConfig.secrets ──────────────────────
  const cfg = (destination.templateConfig ?? {}) as {
    secrets?: Record<string, string>;
  };

  if (!cfg.secrets || Object.keys(cfg.secrets).length === 0) return {};

  const decrypted: Record<string, string> = {};
  for (const [key, encVal] of Object.entries(cfg.secrets)) {
    decrypted[key] = decrypt(encVal);
  }
  return decrypted;
}

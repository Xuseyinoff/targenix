/**
 * connectionService — Phase 3 of the Make.com-style refactor.
 *
 * Thin wrapper around the `connections` table used by:
 *   • universal OAuth callback — auto-creates/updates a google_sheets connection
 *                                when a user connects their Google account
 *   • connectionsRouter        — CRUD entry point for the frontend
 *   • destination save path    — normalises connectionId before writing
 *                                target_websites.connectionId
 *
 * Guiding rules:
 *   1. Never throws on missing rows — callers decide how to react.
 *   2. Pure helpers: no direct encrypt() / decrypt() here, credentials are
 *      stored via credentialsJson as already encrypted blobs.
 *   3. Keeps the `templateConfig` shape untouched — this service only owns
 *      the new `connections` row; adapters continue to fall back to
 *      templateConfig (see telegramAdapter / googleSheetsAdapter).
 */

import { and, eq } from "drizzle-orm";
import { connections, oauthTokens, targetWebsites } from "../../drizzle/schema";
import type { DbClient } from "../db";
import { validateConnectionType } from "../utils/validateConnectionType";

export type ConnectionType = "google_sheets" | "telegram_bot" | "api_key";
export type ConnectionStatus = "active" | "expired" | "revoked" | "error";

// ─── Google Sheets connection ────────────────────────────────────────────────

interface UpsertGoogleConnectionInput {
  userId: number;
  oauthTokenId: number;
  /** Human-readable email from the Google profile. */
  email: string;
  /** Optional display name override — defaults to the email when omitted. */
  displayName?: string;
}

/**
 * Ensure there is a `connections` row for a given `oauth_tokens` (Google Sheets) row.
 * Called from the universal OAuth callback so a matching connection row appears
 * in /connections and pickers.
 *
 * Behaviour:
 *   • If a connection with the same `oauthTokenId` exists → update
 *     displayName + status + lastVerifiedAt.
 *   • Otherwise insert a fresh row.
 *
 * Returns the connection id (existing or newly inserted).
 */
export async function upsertGoogleConnection(
  db: DbClient,
  input: UpsertGoogleConnectionInput,
): Promise<number> {
  const { userId, oauthTokenId, email } = input;
  const displayName = input.displayName?.trim() || email || "Google account";

  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.type, validateConnectionType("google_sheets")),
        eq(connections.oauthTokenId, oauthTokenId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(connections)
      .set({
        displayName,
        status: "active",
        lastVerifiedAt: new Date(),
        oauthTokenId,
        googleAccountId: null,
      })
      .where(eq(connections.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db.insert(connections).values({
    userId,
    type: "google_sheets",
    displayName,
    status: "active",
    oauthTokenId,
    lastVerifiedAt: new Date(),
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

/**
 * Mark `google_sheets` rows linked to this `oauth_tokens` id as expired (e.g. API 401/403).
 * Best-effort; does not throw.
 */
export async function markGoogleSheetsConnectionsExpiredForOauthToken(
  db: DbClient,
  userId: number,
  oauthTokenId: number,
): Promise<void> {
  try {
    await db
      .update(connections)
      .set({ status: "expired" })
      .where(
        and(
          eq(connections.userId, userId),
          eq(connections.type, validateConnectionType("google_sheets")),
          eq(connections.oauthTokenId, oauthTokenId),
        ),
      );
  } catch {
    // ignore
  }
}

// ─── Telegram bot connection ─────────────────────────────────────────────────

interface UpsertTelegramConnectionInput {
  userId: number;
  displayName: string;
  /** Encrypted bot token — caller is responsible for running encrypt(). */
  botTokenEncrypted: string;
  /** Telegram chat id (numeric string, channel id, or @username). */
  chatId: string;
}

/**
 * Create a telegram_bot connection. Unlike Google, there is no external
 * record to key off — every create call inserts a fresh row. Rename /
 * disconnect go through the router.
 *
 * The caller must have already validated the token + chat id against
 * Telegram (via telegramService.sendTelegramRawMessage) before calling.
 */
export async function insertTelegramConnection(
  db: DbClient,
  input: UpsertTelegramConnectionInput,
): Promise<number> {
  const displayName = input.displayName.trim() || "Telegram bot";

  const [inserted] = await db.insert(connections).values({
    userId: input.userId,
    type: validateConnectionType("telegram_bot"),
    displayName,
    status: "active",
    credentialsJson: {
      botTokenEncrypted: input.botTokenEncrypted,
      chatId: input.chatId.trim(),
    },
    lastVerifiedAt: new Date(),
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

// ─── API-key (admin template) connection ─────────────────────────────────────
// Generic credential bucket for admin-managed affiliates. The shape is
// deliberately schema-agnostic: `secretsEncrypted` is a flat map of
// userVisibleFields key → encrypted value. The adapter looks up the template
// by `templateId` at delivery time and knows which fields to substitute.

interface InsertApiKeyConnectionInput {
  userId: number;
  /** Must be a valid destination_templates.id; verified by the caller. */
  templateId: number;
  /** Label shown in the /connections list, e.g. "Sotuvchi main key". */
  displayName: string;
  /**
   * Already-encrypted values keyed by `userVisibleFields` entries —
   * e.g. `{ api_key: encrypt("BD...XK") }`. Never pass plaintext here.
   */
  secretsEncrypted: Record<string, string>;
}

/**
 * Insert an api_key connection row. Mirrors `insertTelegramConnection` so
 * connectionsRouter stays a thin pass-through — all validation (template
 * existence, field keys) lives in the router.
 */
export async function insertApiKeyConnection(
  db: DbClient,
  input: InsertApiKeyConnectionInput,
): Promise<number> {
  const displayName = input.displayName.trim() || "API key";
  const [inserted] = await db.insert(connections).values({
    userId: input.userId,
    type: validateConnectionType("api_key"),
    displayName,
    status: "active",
    credentialsJson: {
      templateId: input.templateId,
      secretsEncrypted: input.secretsEncrypted,
    },
    lastVerifiedAt: new Date(),
  });
  return (inserted as unknown as { insertId: number }).insertId;
}

// ─── Shared read helpers ─────────────────────────────────────────────────────

/**
 * Returns the raw connections row for this user+id, or null. Used as an
 * ownership check across the router.
 */
export async function findConnectionForUser(
  db: DbClient,
  userId: number,
  connectionId: number,
) {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Count target_websites referencing this connection.
 * Used by:
 *   • list → show "used by N destinations"
 *   • delete → refuse vs confirm flow on the client
 */
export async function countDestinationsUsingConnection(
  db: DbClient,
  userId: number,
  connectionId: number,
): Promise<number> {
  const rows = await db
    .select({ id: targetWebsites.id })
    .from(targetWebsites)
    .where(
      and(
        eq(targetWebsites.userId, userId),
        eq(targetWebsites.connectionId, connectionId),
      ),
    );
  return rows.length;
}

/**
 * Bulk usage counts for a list of connection ids. One SQL round-trip instead
 * of N-of-N — useful for the /connections list endpoint which renders usage
 * inline for every row.
 */
export async function mapConnectionUsage(
  db: DbClient,
  userId: number,
  connectionIds: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (connectionIds.length === 0) return counts;

  const rows = await db
    .select({
      connectionId: targetWebsites.connectionId,
      id: targetWebsites.id,
    })
    .from(targetWebsites)
    .where(eq(targetWebsites.userId, userId));

  for (const r of rows) {
    if (r.connectionId == null) continue;
    counts.set(r.connectionId, (counts.get(r.connectionId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Returns the {id, email, picture, …} tuple for a Google Sheets connection's
 * `oauth_tokens` row. Null when the connection is not google_sheets or the
 * token row is missing.
 */
export async function resolveGoogleAccountForConnection(
  db: DbClient,
  connectionId: number,
) {
  const [row] = await db
    .select({
      oauthTokenId: connections.oauthTokenId,
      type: connections.type,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!row || row.type !== "google_sheets" || !row.oauthTokenId) return null;

  const [account] = await db
    .select({
      id: oauthTokens.id,
      email: oauthTokens.email,
      name: oauthTokens.name,
      picture: oauthTokens.picture,
      expiryDate: oauthTokens.expiryDate,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.id, row.oauthTokenId))
    .limit(1);

  return account ?? null;
}

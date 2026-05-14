/**
 * connectionsRouter — Phase 3 of the Make.com-style refactor.
 *
 * Unified CRUD over the `connections` table. Surfaces:
 *   • list               — all connections for the current user, with usage
 *                          counts and a Google-account preview when applicable
 *   • get                — single row detail (used by the destination forms)
 *   • rename             — update displayName only
 *   • disconnect         — delete a connection and NULL-out every
 *                          destinations.connectionId that pointed at it
 *   • listUsage          — which destinations reference this connection
 *   • createTelegramBot  — user-supplied bot_token + chat_id. Validates the
 *                          bot has the chat before storing.
 *
 * Google connections are NOT created here — they flow through
 * GET /api/oauth/google/callback, which stores tokens in `oauth_tokens` and
 * then calls `upsertGoogleConnection()`.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  connectionHealthLogs,
  connections,
  destinationTemplates,
  oauthTokens,
  destinations,
} from "../../drizzle/schema";
import { encrypt } from "../encryption";
import {
  type ConnectionType,
  countDestinationsUsingConnection,
  findConnectionForUser,
  insertApiKeyConnection,
  insertTelegramConnection,
  mapConnectionUsage,
  relinkOrphanedDestinationsToConnection,
  relinkOrphanedTelegramDestinations,
} from "../services/connectionService";
import {
  verifyConnectionHealth,
  getRecentHealthLogs,
} from "../services/connectionHealthService";
import { sendTelegramRawMessage } from "../services/telegramService";
import { log } from "../services/appLogger";
import { listAppKeyOptionsForPicker } from "../integrations/listAppsSafe";
import { validateConnectionType } from "../utils/validateConnectionType";
import { appendConnectionEvent } from "../services/connectionEventsService";
import { loaderCache } from "../integrations/loaders/cache";
import { checkUserRateLimit } from "../lib/userRateLimit";

// ─── Types returned to the client ────────────────────────────────────────────

interface ListedConnection {
  id: number;
  /** VARCHAR in DB; narrowed at runtime to known adapters. */
  type: ConnectionType;
  displayName: string;
  status: "active" | "expired" | "revoked" | "error";
  createdAt: Date;
  lastVerifiedAt: Date | null;
  usageCount: number;
  /** google_sheets only — `oauth_tokens.id` (client still uses `accountId`) */
  google?: {
    accountId: number;
    email: string;
    name: string | null;
    picture: string | null;
    expired: boolean;
  } | null;
  /** telegram_bot only — previewing credentials would leak the token, so we
   *  only echo the chat id for display. */
  telegram?: {
    chatId: string;
  } | null;
  /** api_key only — the admin-managed template this connection belongs to.
   *  Powers the icon / color / name in the unified /connections list so the
   *  user doesn't see a faceless "api_key" row. */
  apiKey?: {
    templateId: number;
    templateName: string;
    templateColor: string;
    /** `destination_templates.appKey` — drives `/api/brand-icons-by-key/…`. */
    templateAppKey: string | null;
    /** Keys present in credentialsJson.secretsEncrypted — for display only. */
    secretKeys: string[];
  } | null;
}

// ─── Credential scrub helper ─────────────────────────────────────────────────
//
// Used by `disconnect` to remove credential-shaped fields from
// `destinations.templateConfig` without nuking the non-secret
// configuration. Names that look like credentials (api_key, secret,
// token, password, *Encrypted, or the catch-all `secrets`/`credentials`
// nested objects) drop out; everything else (spreadsheetId, sheetName,
// chatId, mapping, url, method, …) stays so re-attaching a new connection
// doesn't force the user to re-enter destination config.
//
// Keep the rule LIBERAL — false positives only inconvenience the user
// (they re-enter a benign field); false negatives leak credentials.

const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key$/i,           // api_key, apiKey, api-key
  /^secret/i,                // secret, secrets, secretKey
  /token$/i,                 // accessToken, refreshToken, botToken
  /^token/i,                 // token, tokenSecret
  /password/i,               // password, passwordHash
  /credentials/i,            // credentials, credentialsJson
  /encrypted$/i,             // anythingEncrypted
  /^auth$/i,                 // auth (whole bearer/basic blob)
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

export function scrubSecretsFromTemplateConfig(tc: unknown): {
  scrubbed: Record<string, unknown>;
  removed: number;
} {
  if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
    return { scrubbed: {}, removed: 0 };
  }
  const out: Record<string, unknown> = {};
  let removed = 0;
  for (const [k, v] of Object.entries(tc as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      removed++;
      continue;
    }
    out[k] = v;
  }
  return { scrubbed: out, removed };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const connectionsRouter = router({
  /**
   * Lightweight count of "needs attention" connections for the current
   * user. Drives the dashboard banner in /overview — keep it cheap (single
   * grouped COUNT, no joins) so the home page is never blocked by it.
   *
   * Sprint 2 / Item 2.2.
   */
  attentionCount: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { expired: 0, revoked: 0, error: 0, total: 0 };
    const rows = await db
      .select({
        status: connections.status,
        n: sql<number>`COUNT(*)`,
      })
      .from(connections)
      .where(
        and(
          eq(connections.userId, ctx.user.id),
          inArray(connections.status, ["expired", "revoked", "error"] as const),
        ),
      )
      .groupBy(connections.status);
    const out = { expired: 0, revoked: 0, error: 0, total: 0 };
    for (const r of rows) {
      const n = Number(r.n) || 0;
      if (r.status === "expired") out.expired = n;
      else if (r.status === "revoked") out.revoked = n;
      else if (r.status === "error") out.error = n;
      out.total += n;
    }
    return out;
  }),

  /**
   * List the current user's connections, newest first. Optional `type`
   * filter is used by the ConnectionPicker on destination forms.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          type: z
            .enum(["google_sheets", "telegram_bot", "api_key", "hubspot", "kommo", "pipedrive"])
            .optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }): Promise<ListedConnection[]> => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const whereClauses = [eq(connections.userId, userId)];
      if (input?.type) whereClauses.push(eq(connections.type, input.type));

      const rows = await db
        .select({
          id: connections.id,
          type: connections.type,
          displayName: connections.displayName,
          status: connections.status,
          oauthTokenId: connections.oauthTokenId,
          credentialsJson: connections.credentialsJson,
          createdAt: connections.createdAt,
          lastVerifiedAt: connections.lastVerifiedAt,
        })
        .from(connections)
        .where(and(...whereClauses))
        .orderBy(desc(connections.createdAt));

      if (rows.length === 0) return [];

      const usage = await mapConnectionUsage(db, userId, rows.map((r) => r.id));

      // Fetch oauth_tokens in one round-trip for google_sheets rows
      const tokenIds = rows
        .map((r) => r.oauthTokenId)
        .filter((x): x is number => typeof x === "number");
      const googleById = new Map<
        number,
        {
          id: number;
          email: string;
          name: string | null;
          picture: string | null;
          expiryDate: Date | null;
        }
      >();
      if (tokenIds.length > 0) {
        const accounts = await db
          .select({
            id: oauthTokens.id,
            email: oauthTokens.email,
            name: oauthTokens.name,
            picture: oauthTokens.picture,
            expiryDate: oauthTokens.expiryDate,
          })
          .from(oauthTokens)
          .where(inArray(oauthTokens.id, tokenIds));
        for (const a of accounts) googleById.set(a.id, a);
      }

      // Resolve template metadata for api_key rows in one round-trip. The
      // templateId lives inside credentialsJson.templateId (stored at create
      // time), so we dig it out before querying destination_templates.
      const templateIds = rows
        .filter((r) => r.type === "api_key")
        .map((r) => {
          const creds = (r.credentialsJson ?? {}) as Record<string, unknown>;
          return typeof creds.templateId === "number" ? creds.templateId : null;
        })
        .filter((id): id is number => id !== null);

      const templateById = new Map<
        number,
        { id: number; name: string; color: string; appKey: string | null }
      >();
      if (templateIds.length > 0) {
        const tpls = await db
          .select({
            id: destinationTemplates.id,
            name: destinationTemplates.name,
            color: destinationTemplates.color,
            appKey: destinationTemplates.appKey,
          })
          .from(destinationTemplates)
          .where(inArray(destinationTemplates.id, templateIds));
        for (const t of tpls) templateById.set(t.id, t);
      }

      const now = Date.now();

      return rows.map((r): ListedConnection => {
        let google: ListedConnection["google"] = null;
        if (r.type === "google_sheets" && r.oauthTokenId) {
          const acc = googleById.get(r.oauthTokenId);
          if (acc) {
            google = {
              accountId: acc.id,
              email: acc.email,
              name: acc.name,
              picture: acc.picture,
              expired: acc.expiryDate ? acc.expiryDate.getTime() < now : false,
            };
          }
        }

        let telegram: ListedConnection["telegram"] = null;
        if (r.type === "telegram_bot") {
          const creds = (r.credentialsJson ?? {}) as Record<string, unknown>;
          const chatId = typeof creds.chatId === "string" ? creds.chatId : "";
          telegram = { chatId };
        }

        let apiKey: ListedConnection["apiKey"] = null;
        if (r.type === "api_key") {
          const creds = (r.credentialsJson ?? {}) as Record<string, unknown>;
          const tplId =
            typeof creds.templateId === "number" ? creds.templateId : null;
          const secretsEncrypted = (creds.secretsEncrypted ??
            {}) as Record<string, unknown>;
          if (tplId != null) {
            const meta = templateById.get(tplId);
            if (meta) {
              apiKey = {
                templateId: meta.id,
                templateName: meta.name,
                templateColor: meta.color,
                templateAppKey: meta.appKey ?? null,
                secretKeys: Object.keys(secretsEncrypted),
              };
            }
          }
        }

        return {
          id: r.id,
          type: r.type as ConnectionType,
          displayName: r.displayName,
          status: r.status,
          createdAt: r.createdAt,
          lastVerifiedAt: r.lastVerifiedAt,
          usageCount: usage.get(r.id) ?? 0,
          google,
          telegram,
          apiKey,
        };
      });
    }),

  /**
   * Connection-app catalogue (appKey, authType, …) — same DTO as
   * `adminTemplates.listAppKeys`, read from `apps` with legacy fallback.
   */
  listAppKeys: protectedProcedure.query(async () => {
    const db = await getDb();
    return listAppKeyOptionsForPicker(db);
  }),

  /** Single connection detail; used when the UI needs a fresh snapshot. */
  get: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }
      const row = await findConnectionForUser(db, userId, input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
      }
      return {
        id: row.id,
        type: row.type,
        displayName: row.displayName,
        status: row.status,
        createdAt: row.createdAt,
        lastVerifiedAt: row.lastVerifiedAt,
      };
    }),

  /**
   * List destinations referencing this connection. Rendered in the
   * "Disconnect" dialog so the user understands the impact.
   */
  listUsage: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const row = await findConnectionForUser(db, userId, input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
      }

      return db
        .select({
          id: destinations.id,
          name: destinations.name,
          appKey: destinations.appKey,
          isActive: destinations.isActive,
        })
        .from(destinations)
        .where(
          and(
            eq(destinations.userId, userId),
            eq(destinations.connectionId, input.id),
          ),
        )
        .orderBy(desc(destinations.createdAt));
    }),

  /** Rename a connection — only the displayName is touched. */
  rename: protectedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        displayName: z.string().trim().min(1).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const row = await findConnectionForUser(db, userId, input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
      }

      const newName = input.displayName.trim();
      const oldName = row.displayName;
      await db
        .update(connections)
        .set({ displayName: newName })
        .where(eq(connections.id, input.id));

      void appendConnectionEvent(db, {
        connectionId: input.id,
        userId,
        eventType: "renamed",
        source: "user",
        details: { from: oldName, to: newName },
      });

      return { success: true };
    }),

  /**
   * Remove the connection and clear every destinations.connectionId that
   * pointed at it. In addition to the FK clear we SCRUB credential-shaped
   * keys from `destinations.templateConfig` so disconnect = real
   * disconnect, not "soft-disconnect with backup credential still on disk".
   *
   * Sprint 2 / Item 2.1 — the previous version left `templateConfig.secrets`
   * intact ("adapters fall back to templateConfig") which was a credential
   * retention hazard: when a user clicked Disconnect believing the credential
   * was gone, adapters could still deliver using the inline copy. The new
   * contract is: Disconnect erases both copies. Non-secret fields
   * (spreadsheetId, sheetName, chatId, mapping, url, …) are preserved so
   * the destination keeps its configuration shell and the user can re-attach
   * a fresh connection without re-typing config.
   */
  disconnect: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const row = await findConnectionForUser(db, userId, input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
      }

      const usage = await countDestinationsUsingConnection(db, userId, input.id);

      let scrubbedKeysCount = 0;
      let deletedOrphanToken = false;
      await db.transaction(async (tx) => {
        // Snapshot the connection's oauthTokenId BEFORE deleting the row, so
        // we can run the last-reference cleanup below.
        const [conn] = await tx
          .select({ oauthTokenId: connections.oauthTokenId })
          .from(connections)
          .where(and(eq(connections.id, input.id), eq(connections.userId, userId)))
          .limit(1);
        const oauthTokenId = conn?.oauthTokenId ?? null;

        // Per-row scrub: read each affected destination's templateConfig,
        // strip credential-shaped keys, write back. Bulk UPDATE can't
        // selectively edit JSON paths in MySQL 5.7-compatible way, and the
        // set is tiny in practice (usually <10 rows per connection).
        const affected = await tx
          .select({
            id: destinations.id,
            templateConfig: destinations.templateConfig,
          })
          .from(destinations)
          .where(
            and(
              eq(destinations.userId, userId),
              eq(destinations.connectionId, input.id),
            ),
          );

        for (const tw of affected) {
          const { scrubbed, removed } = scrubSecretsFromTemplateConfig(tw.templateConfig);
          scrubbedKeysCount += removed;
          await tx
            .update(destinations)
            .set({ connectionId: null, templateConfig: scrubbed })
            .where(eq(destinations.id, tw.id));
        }

        await tx
          .delete(connections)
          .where(
            and(eq(connections.id, input.id), eq(connections.userId, userId)),
          );

        // Last-reference cleanup: oauth_tokens is a shared "library" layer —
        // several connections can point at one token row. When the
        // connection we just deleted was the LAST one referencing its
        // oauth_token, that token is now orphaned and would otherwise sit
        // decryptable in the DB indefinitely. Delete it once nothing points
        // at it. (googleAccountsRouter.disconnect covers the "remove the
        // whole Google account" path; this covers the "disconnect the last
        // connection that used it" path.)
        if (oauthTokenId != null) {
          const stillReferenced = await tx
            .select({ id: connections.id })
            .from(connections)
            .where(eq(connections.oauthTokenId, oauthTokenId))
            .limit(1);
          if (stillReferenced.length === 0) {
            await tx
              .delete(oauthTokens)
              .where(and(eq(oauthTokens.id, oauthTokenId), eq(oauthTokens.userId, userId)));
            deletedOrphanToken = true;
          }
        }
      });

      // Drop any cached loader results derived from this connection's now-
      // revoked credentials so they can't be served during the 60s TTL.
      loaderCache.invalidateByConnection(userId, input.id);

      void appendConnectionEvent(db, {
        connectionId: input.id,
        userId,
        eventType: "disconnected",
        source: "user",
        details: {
          type: row.type,
          displayName: row.displayName,
          clearedDestinations: usage,
          scrubbedSecretKeys: scrubbedKeysCount,
          deletedOrphanToken,
        },
      });

      await log.info("CONNECTIONS", "connection disconnected", {
        userId,
        connectionId: input.id,
        type: row.type,
        clearedDestinations: usage,
        scrubbedSecretKeys: scrubbedKeysCount,
        deletedOrphanToken,
      });

      return { success: true, clearedDestinations: usage };
    }),

  /**
   * Create a connection for a user-supplied Telegram bot + chat.
   * The bot token is validated against Telegram (sendMessage probe) before
   * the encrypted value is persisted, so we don't store garbage credentials.
   */
  createTelegramBot: protectedProcedure
    .input(
      z.object({
        displayName: z.string().trim().min(1).max(255),
        botToken: z.string().trim().min(10).max(255),
        chatId: z.string().trim().min(1).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Each call fires a live Telegram API probe — tighter ceiling than a
      // plain DB insert. 10/min covers legitimate retries on a bad token.
      checkUserRateLimit(ctx.user.id, "connectionCreate", {
        max: 10,
        windowMs: 60_000,
        message: "Too many connection attempts. Max 10 per minute.",
      });

      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      // Validate bot+chat pairing with a non-destructive probe.
      // `sendTelegramRawMessage` returns a DeliveryResult — on failure we
      // surface a friendly BAD_REQUEST so the form can render the error.
      const probe = await sendTelegramRawMessage(
        input.botToken,
        input.chatId,
        "✅ Targenix: connection test — you can delete this message.",
      );
      if (!probe.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: probe.error ?? "Failed to verify Telegram bot / chat",
        });
      }

      validateConnectionType("telegram_bot");

      const id = await insertTelegramConnection(db, {
        userId: ctx.user.id,
        displayName: input.displayName,
        botTokenEncrypted: encrypt(input.botToken),
        chatId: input.chatId,
      });

      // Heal the "disconnect old bot → create new bot" gap, same class of
      // bug fixed for createApiKey. A Mode-A telegram destination keeps its
      // bot token only in the connection, so a prior `disconnect` leaves it
      // credential-less. Re-link by exact chatId match — only destinations
      // that were delivering to THIS connection's chat — so leads can never
      // be routed into the wrong Telegram chat.
      const relinkedDestinationIds = await relinkOrphanedTelegramDestinations(db, {
        userId: ctx.user.id,
        connectionId: id,
        chatId: input.chatId.trim(),
      });

      void appendConnectionEvent(db, {
        connectionId: id,
        userId: ctx.user.id,
        eventType: "created",
        source: "user",
        details: {
          type: "telegram_bot",
          displayName: input.displayName,
          ...(relinkedDestinationIds.length > 0
            ? { relinkedDestinationIds }
            : {}),
        },
      });

      await log.info("CONNECTIONS", "telegram connection created", {
        userId: ctx.user.id,
        connectionId: id,
        relinkedDestinations: relinkedDestinationIds.length,
      });

      return {
        success: true,
        id,
        relinkedDestinations: relinkedDestinationIds.length,
      };
    }),

  /**
   * Create an api_key connection for an admin-managed destination template.
   *
   * The schema is intentionally driven by `destination_templates.userVisibleFields`:
   *   • the router loads the template, reads `userVisibleFields` (e.g. ["api_key"])
   *   • every key present there MUST have a value in `secrets`
   *   • extra keys are rejected so we never silently persist mystery values
   *
   * Storing the encrypted map under `credentialsJson.secretsEncrypted` keeps
   * the existing `dynamicTemplateAdapter` `{{SECRET:...}}` substitution
   * compatible: once Phase 2D migrates adapters to read from `connections`,
   * the lookup path is a drop-in.
   */
  createApiKey: protectedProcedure
    .input(
      z.object({
        templateId: z.number().int().positive(),
        displayName: z.string().trim().min(1).max(255),
        secrets: z.record(z.string().min(1), z.string().trim().min(1)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      // Shares the `connectionCreate` bucket with createTelegramBot so a
      // user can't sidestep the limit by alternating connection types.
      checkUserRateLimit(userId, "connectionCreate", {
        max: 10,
        windowMs: 60_000,
        message: "Too many connection attempts. Max 10 per minute.",
      });

      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database not available",
        });
      }

      const [tpl] = await db
        .select({
          id: destinationTemplates.id,
          name: destinationTemplates.name,
          isActive: destinationTemplates.isActive,
          userVisibleFields: destinationTemplates.userVisibleFields,
        })
        .from(destinationTemplates)
        .where(eq(destinationTemplates.id, input.templateId))
        .limit(1);

      if (!tpl || !tpl.isActive) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found or inactive",
        });
      }

      const expectedKeys = (tpl.userVisibleFields as string[]) ?? [];
      const missing = expectedKeys.filter((k) => !input.secrets[k]);
      if (missing.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Missing required fields: ${missing.join(", ")}`,
        });
      }
      const extra = Object.keys(input.secrets).filter(
        (k) => !expectedKeys.includes(k),
      );
      if (extra.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown fields for this template: ${extra.join(", ")}`,
        });
      }

      const secretsEncrypted: Record<string, string> = {};
      for (const key of expectedKeys) {
        secretsEncrypted[key] = encrypt(input.secrets[key]);
      }

      validateConnectionType("api_key");

      const id = await insertApiKeyConnection(db, {
        userId,
        templateId: tpl.id,
        displayName: input.displayName,
        secretsEncrypted,
      });

      // Heal destinations orphaned by a prior `disconnect` of this template's
      // previous connection. Without this, "disconnect old key → add new key"
      // leaves the destination with connectionId = NULL and every lead fails
      // with CONNECTION_REQUIRED until the user re-picks the connection by
      // hand. Tightly scoped — see relinkOrphanedDestinationsToConnection.
      const relinkedDestinationIds = await relinkOrphanedDestinationsToConnection(db, {
        userId,
        templateId: tpl.id,
        connectionId: id,
      });

      void appendConnectionEvent(db, {
        connectionId: id,
        userId,
        eventType: "created",
        source: "user",
        details: {
          type: "api_key",
          displayName: input.displayName,
          templateId: tpl.id,
          templateName: tpl.name,
          ...(relinkedDestinationIds.length > 0
            ? { relinkedDestinationIds }
            : {}),
        },
      });

      await log.info("CONNECTIONS", "api_key connection created", {
        userId,
        connectionId: id,
        templateId: tpl.id,
        templateName: tpl.name,
        relinkedDestinations: relinkedDestinationIds.length,
      });

      return {
        success: true,
        id,
        relinkedDestinations: relinkedDestinationIds.length,
      };
    }),

  /**
   * Manually trigger a health check for a single connection.
   * Returns { ok, latencyMs, error?, newStatus, tokenRefreshed? }.
   * Also writes to connection_health_logs and updates connections.status.
   */
  verify: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const row = await findConnectionForUser(db, userId, input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });

      const result = await verifyConnectionHealth(db, input.id, userId);

      await log.info("CONNECTIONS", "connection verified", {
        userId,
        connectionId: input.id,
        type: row.type,
        ok: result.ok,
        latencyMs: result.latencyMs,
        tokenRefreshed: result.tokenRefreshed,
      });

      return result;
    }),

  /**
   * Return the last N health check log entries for a connection.
   * Used by the Connection Manager detail panel.
   */
  healthLogs: protectedProcedure
    .input(z.object({
      id:    z.number().int().positive(),
      limit: z.number().int().min(1).max(50).default(10),
    }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return [];

      const row = await findConnectionForUser(db, userId, input.id);
      if (!row) return [];

      return getRecentHealthLogs(db, input.id, input.limit);
    }),
});

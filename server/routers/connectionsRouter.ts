/**
 * connectionsRouter — Phase 3 of the Make.com-style refactor.
 *
 * Unified CRUD over the `connections` table. Surfaces:
 *   • list               — all connections for the current user, with usage
 *                          counts and a Google-account preview when applicable
 *   • get                — single row detail (used by the destination forms)
 *   • rename             — update displayName only
 *   • disconnect         — delete a connection and NULL-out every
 *                          target_websites.connectionId that pointed at it
 *   • listUsage          — which destinations reference this connection
 *   • createTelegramBot  — user-supplied bot_token + chat_id. Validates the
 *                          bot has the chat before storing.
 *
 * Google connections are NOT created here — they flow through
 * /api/auth/google/callback (see googleOAuth.ts) which already encrypts
 * and stores tokens and then calls upsertGoogleConnection().
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  connections,
  googleAccounts,
  targetWebsites,
} from "../../drizzle/schema";
import { encrypt } from "../encryption";
import {
  countDestinationsUsingConnection,
  findConnectionForUser,
  insertTelegramConnection,
  mapConnectionUsage,
} from "../services/connectionService";
import { sendTelegramRawMessage } from "../services/telegramService";
import { log } from "../services/appLogger";

// ─── Types returned to the client ────────────────────────────────────────────

interface ListedConnection {
  id: number;
  type: "google_sheets" | "telegram_bot" | "api_key";
  displayName: string;
  status: "active" | "expired" | "revoked" | "error";
  createdAt: Date;
  lastVerifiedAt: Date | null;
  usageCount: number;
  /** google_sheets only — preview of linked google_accounts row */
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
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const connectionsRouter = router({
  /**
   * List the current user's connections, newest first. Optional `type`
   * filter is used by the ConnectionPicker on destination forms.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          type: z
            .enum(["google_sheets", "telegram_bot", "api_key"])
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
          googleAccountId: connections.googleAccountId,
          credentialsJson: connections.credentialsJson,
          createdAt: connections.createdAt,
          lastVerifiedAt: connections.lastVerifiedAt,
        })
        .from(connections)
        .where(and(...whereClauses))
        .orderBy(desc(connections.createdAt));

      if (rows.length === 0) return [];

      const usage = await mapConnectionUsage(db, userId, rows.map((r) => r.id));

      // Fetch google_accounts in one round-trip for google_sheets rows
      const googleIds = rows
        .map((r) => r.googleAccountId)
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
      if (googleIds.length > 0) {
        const accounts = await db
          .select({
            id: googleAccounts.id,
            email: googleAccounts.email,
            name: googleAccounts.name,
            picture: googleAccounts.picture,
            expiryDate: googleAccounts.expiryDate,
          })
          .from(googleAccounts)
          .where(inArray(googleAccounts.id, googleIds));
        for (const a of accounts) googleById.set(a.id, a);
      }

      const now = Date.now();

      return rows.map((r): ListedConnection => {
        let google: ListedConnection["google"] = null;
        if (r.type === "google_sheets" && r.googleAccountId) {
          const acc = googleById.get(r.googleAccountId);
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

        return {
          id: r.id,
          type: r.type,
          displayName: r.displayName,
          status: r.status,
          createdAt: r.createdAt,
          lastVerifiedAt: r.lastVerifiedAt,
          usageCount: usage.get(r.id) ?? 0,
          google,
          telegram,
        };
      });
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
          id: targetWebsites.id,
          name: targetWebsites.name,
          templateType: targetWebsites.templateType,
          isActive: targetWebsites.isActive,
        })
        .from(targetWebsites)
        .where(
          and(
            eq(targetWebsites.userId, userId),
            eq(targetWebsites.connectionId, input.id),
          ),
        )
        .orderBy(desc(targetWebsites.createdAt));
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

      await db
        .update(connections)
        .set({ displayName: input.displayName.trim() })
        .where(eq(connections.id, input.id));

      return { success: true };
    }),

  /**
   * Remove the connection and clear every target_websites.connectionId that
   * pointed at it. Adapters will fall back to templateConfig (legacy inline
   * credentials) so delivery never breaks mid-flight.
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

      await db.transaction(async (tx) => {
        await tx
          .update(targetWebsites)
          .set({ connectionId: null })
          .where(
            and(
              eq(targetWebsites.userId, userId),
              eq(targetWebsites.connectionId, input.id),
            ),
          );

        await tx
          .delete(connections)
          .where(
            and(eq(connections.id, input.id), eq(connections.userId, userId)),
          );
      });

      await log.info("CONNECTIONS", "connection disconnected", {
        userId,
        connectionId: input.id,
        type: row.type,
        clearedDestinations: usage,
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

      const id = await insertTelegramConnection(db, {
        userId: ctx.user.id,
        displayName: input.displayName,
        botTokenEncrypted: encrypt(input.botToken),
        chatId: input.chatId,
      });

      await log.info("CONNECTIONS", "telegram connection created", {
        userId: ctx.user.id,
        connectionId: id,
      });

      return { success: true, id };
    }),
});

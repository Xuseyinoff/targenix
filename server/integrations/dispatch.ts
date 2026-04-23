/**
 * Unified delivery dispatcher — Phase 1 of Make.com-style refactor.
 *
 * Replaces the hardcoded if/else chain inside leadService.runOrderIntegrationSend
 * with a single code path:
 *   1. resolveAdapterKey()  → picks adapter key from integrationType + targetWebsite
 *   2. getAdapter(key)      → fetches the adapter instance from the registry
 *   3. buildAdapterInput()  → constructs the per-adapter config shape
 *
 * SAFETY: this file is an *additive* helper. It reproduces the exact same branch
 * selection and adapter arguments as the legacy inline dispatcher, so behaviour
 * is byte-for-byte identical for every currently supported destination type
 * (affiliate, dynamic-template, telegram, google-sheets, legacy-template,
 * plain-url). It introduces zero new side effects and zero new network calls.
 */

import "./register";

import { eq } from "drizzle-orm";
import type { DbClient } from "../db";
import type { Connection, leads, targetWebsites } from "../../drizzle/schema";
import { connections as connectionsTable } from "../../drizzle/schema";
import type { LeadPayload } from "../services/affiliateService";
import type { DeliveryResult } from "./types";
import { getAdapter } from "./registry";
import { resolveAdapterKey } from "./resolveAdapterKey";

export interface DispatchContext {
  db: DbClient;
  userId: number;
  /** "AFFILIATE" goes to affiliateAdapter; "LEAD_ROUTING" resolves via targetWebsite. */
  integrationType: "AFFILIATE" | "LEAD_ROUTING";
  /** Raw integrations.config JSON (targetUrl, variableFields, offerId, flow, …). */
  integrationConfig: Record<string, unknown>;
  /** Destination row. null → plain-url fallback (legacy behaviour). */
  targetWebsite: typeof targetWebsites.$inferSelect | null;
  /** Lead row for Telegram/Sheets context (pageName, formName, createdAt). */
  leadRow?: Partial<typeof leads.$inferSelect>;
  /** Per-integration variable overrides merged from integrationConfig.variableFields. */
  variableFields?: Record<string, string>;
}

export type DispatchOutcome = DeliveryResult & {
  /** Which adapter was invoked (for logs / diagnostics). */
  adapterKey: string;
  /** Populated for adapters that hit a user-defined URL — used by log payloads. */
  targetUrlUsed?: string;
};

/**
 * Stage 2 — just-in-time connection loader for the delivery hot path.
 *
 * Returns the `connections` row linked to a destination (via
 * `target_websites.connectionId`) when one exists, or `null` when no
 * connection is bound. Failure to load the row (not found, DB error)
 * degrades gracefully: we log and return `null`, letting the caller
 * fall through to `templateConfig.secrets` — the pre-Stage-2 path —
 * so a transient DB hiccup never translates into a hard delivery
 * failure for destinations that have legacy secrets populated too.
 *
 * Multi-tenant safety: the lookup goes strictly by primary key. The
 * caller passes `userId` so we can assert the row belongs to the same
 * tenant before handing it downstream (prevents a stray
 * cross-tenant reference from silently sharing credentials).
 */
async function loadConnectionForDelivery(
  db: DbClient,
  connectionId: number,
  userId: number,
): Promise<Connection | null> {
  try {
    const [row] = await db
      .select()
      .from(connectionsTable)
      .where(eq(connectionsTable.id, connectionId))
      .limit(1);
    if (!row) return null;
    if (row.userId !== userId) {
      // Must never happen in practice (FK + ownership checks at write
      // time) but treating it as "no connection" is safer than throwing
      // — the adapter will fall back to templateConfig.secrets and log
      // an explicit ownership-mismatch warning.
      console.warn(
        "[dispatch] connection ownership mismatch — falling back to templateConfig.secrets",
        { connectionId, tenantExpected: userId, tenantActual: row.userId },
      );
      return null;
    }
    return row;
  } catch (err) {
    console.error("[dispatch] failed to load connection row", {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve + invoke the correct adapter for this integration + destination.
 * Never throws — any failure is converted to a DeliveryResult with success=false.
 */
export async function dispatchDelivery(
  ctx: DispatchContext,
  leadPayload: LeadPayload,
): Promise<DispatchOutcome> {
  const adapterKey = resolveAdapterKey(ctx.integrationType, ctx.targetWebsite);
  const adapter = getAdapter(adapterKey);
  if (!adapter) {
    return {
      success: false,
      error: `No adapter registered for key '${adapterKey}'`,
      errorType: "validation",
      adapterKey,
    };
  }

  const tw = ctx.targetWebsite;
  const variableFields = ctx.variableFields ?? {};
  const cfg = ctx.integrationConfig ?? {};
  const leadRow = ctx.leadRow ?? {};

  // Stage 2 — eagerly load the linked connection row ONLY for adapters
  // that actually consume secrets from it. Today that is `legacy-template`
  // and `dynamic-template`; the `telegram` / `google-sheets` adapters
  // already resolve their own credentials via `connectionId`, and
  // `affiliate` / `plain-url` don't use the `connections` store at all,
  // so we skip the DB round-trip for them. If `tw.connectionId` is not
  // set the loader is never called → zero added cost for legacy
  // destinations.
  const needsConnection =
    (adapterKey === "legacy-template" || adapterKey === "dynamic-template") &&
    tw?.connectionId != null;
  const connection: Connection | null = needsConnection
    ? await loadConnectionForDelivery(ctx.db, tw!.connectionId!, ctx.userId)
    : null;

  let adapterInput: unknown;
  let targetUrlUsed: string | undefined;

  switch (adapterKey) {
    case "affiliate": {
      adapterInput = cfg;
      break;
    }

    case "dynamic-template": {
      adapterInput = {
        db: ctx.db,
        targetWebsite: tw,
        variableFields,
        connection,
      };
      break;
    }

    case "telegram": {
      adapterInput = {
        templateConfig: tw?.templateConfig,
        leadRow,
        db: ctx.db,
        userId: ctx.userId,
        connectionId: tw?.connectionId ?? null,
      };
      break;
    }

    case "google-sheets": {
      adapterInput = {
        templateConfig: tw?.templateConfig,
        userId: ctx.userId,
        leadRow,
        db: ctx.db,
        connectionId: tw?.connectionId ?? null,
      };
      break;
    }

    case "legacy-template": {
      targetUrlUsed = (tw?.url as string | null | undefined) ?? undefined;
      adapterInput = {
        templateType: tw?.templateType,
        templateConfig: tw?.templateConfig,
        variableFields,
        url: tw?.url,
        connection,
      };
      break;
    }

    case "plain-url":
    default: {
      targetUrlUsed = (cfg.targetUrl as string | undefined) ?? undefined;
      adapterInput = cfg;
      break;
    }
  }

  const result = await adapter.send(adapterInput, leadPayload);
  return { ...result, adapterKey, targetUrlUsed };
}

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
 * (dynamic-template, telegram, google-sheets, http-api-key, http-oauth2,
 * plain-url). For `dynamic-template` only, a single optional SELECT on
 * `destination_templates` may run when `target_websites.url` is empty — used
 * solely to populate `targetUrlUsed` for ORDER logs; delivery path unchanged.
 */

import "./register";
// Ensure the manifest registry is populated before http-api-key adapter looks up manifests.
import "./apps/index";

import { eq } from "drizzle-orm";
import type { DbClient } from "../db";
import type { Connection, leads, destinations } from "../../drizzle/schema";
import { connections as connectionsTable, appActions, destinationTemplates } from "../../drizzle/schema";
import type { LeadPayload } from "../services/affiliateService";
import type { DeliveryResult } from "./types";
import { getAdapter } from "./registry";
import { resolveAdapterKey } from "./resolveAdapterKey";

export interface DispatchContext {
  db: DbClient;
  userId: number;
  /** Only LEAD_ROUTING remains — the standalone AFFILIATE type was retired. */
  integrationType: "LEAD_ROUTING";
  /** Raw integrations.config JSON (targetUrl, variableFields, offerId, flow, …). */
  integrationConfig: Record<string, unknown>;
  /** Destination row. null → plain-url fallback (legacy behaviour). */
  targetWebsite: typeof destinations.$inferSelect | null;
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
/**
 * Load a `connections` row for delivery, with multi-tenant checks.
 * Exported so `testIntegration` in targetWebsitesRouter can mirror the
 * same connection wiring as `dispatchDelivery` (Stage 3 parity).
 */
export async function loadConnectionForDelivery(
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
      // Sprint 2 / Item 2.3 — owner mismatch is a TENANT BOUNDARY VIOLATION
      // and must be visible in the AdminLogs page (and any downstream pager).
      // The previous `console.warn` was invisible to anyone not tailing the
      // process. We still return null (safer than throwing — the adapter
      // falls back to templateConfig.secrets, never to the wrong tenant's
      // credential), but the SECURITY-category log makes the breach
      // attempt loud.
      const { log } = await import("../services/appLogger");
      void log.error(
        "SECURITY",
        "Connection owner mismatch in dispatch — refusing to use cross-tenant credential",
        { connectionId, tenantExpected: userId, tenantActual: row.userId },
        null,
        null,
        userId,
        "owner_mismatch",
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
const APP_ROUTING_LOG =
  process.env.STAGE2_APP_ROUTING_LOG === "1" || process.env.STAGE2_APP_ROUTING_LOG === "true";

export async function dispatchDelivery(
  ctx: DispatchContext,
  leadPayload: LeadPayload,
): Promise<DispatchOutcome> {
  const tw = ctx.targetWebsite;
  const adapterKey = resolveAdapterKey(ctx.integrationType, tw);
  if (APP_ROUTING_LOG) {
    const raw = tw?.appKey;
    const appKey = raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
    console.log({
      stage: "app_routing" as const,
      appKey,
      templateType: tw?.templateType ?? null,
      adapterUsed: adapterKey,
    });
  }
  const adapter = getAdapter(adapterKey);
  if (!adapter) {
    return {
      success: false,
      error: `No adapter registered for key '${adapterKey}'`,
      errorType: "validation",
      adapterKey,
    };
  }
  const variableFields = ctx.variableFields ?? {};
  const cfg = ctx.integrationConfig ?? {};
  const leadRow = ctx.leadRow ?? {};

  // Stage 2 — eagerly load the linked connection row ONLY for adapters
  // that actually consume secrets from it. Today that is `dynamic-template`;
  // the `telegram` / `google-sheets` adapters already resolve their own
  // credentials via `connectionId`, and `plain-url` doesn't use the
  // `connections` store at all, so we skip the DB round-trip for them.
  // If `tw.connectionId` is not set the loader is never called → zero
  // added cost for legacy destinations.
  const needsConnection =
    adapterKey === "dynamic-template" && tw?.connectionId != null;
  const connection: Connection | null = needsConnection
    ? await loadConnectionForDelivery(ctx.db, tw!.connectionId!, ctx.userId)
    : null;

  let adapterInput: unknown;
  let targetUrlUsed: string | undefined;

  switch (adapterKey) {
    case "dynamic-template": {
      // Sprint 4 / Item 4.4 — MISROUTED_ADAPTER_GUARD removed.
      //
      // The guard short-circuited telegram / google-sheets if they ever
      // reached this adapter, returning a sentinel "MISROUTED_ADAPTER_GUARD"
      // error. It never fired in production logs (3 months of traffic) and
      // resolveAdapterKey.ts already steers those appKeys to dedicated
      // adapters via TWO independent paths (appKey-first and templateType-
      // first). The dual routing block makes a misroute structurally
      // impossible without simultaneous corruption of both columns.
      // If a misroute did somehow occur, the dynamic-template adapter would
      // fail naturally on its first HTTP call (no template URL for a
      // telegram-shaped destination) — no credential leak risk, just an
      // ordinary delivery failure logged as such.
      // ORDER logs read `targetUrlUsed` from dispatch (leadService.ts). Legacy
      // paths set it from tw.url / integration.config.targetUrl; dynamic-template
      // historically left it unset → `targetUrl: undefined` despite success.
      // Source: denormalized target_websites.url (written from template.endpointUrl
      // at create), else one lightweight lookup of destination_templates.endpointUrl.
      {
        const denorm =
          tw?.url != null && typeof tw.url === "string" && tw.url.trim().length > 0
            ? tw.url.trim()
            : undefined;
        if (denorm) {
          targetUrlUsed = denorm;
        } else if (tw?.templateId != null) {
          try {
            let ep: string | null | undefined;
            let urlLogSource: "app_actions" | "destination_templates" = "destination_templates";
            if (tw.actionId != null) {
              const [a] = await ctx.db
                .select({ endpointUrl: appActions.endpointUrl })
                .from(appActions)
                .where(eq(appActions.id, tw.actionId))
                .limit(1);
              const fromA = a?.endpointUrl;
              if (fromA != null && typeof fromA === "string" && fromA.trim() !== "") {
                ep = fromA;
                urlLogSource = "app_actions";
              }
            }
            if (ep == null || (typeof ep === "string" && ep.trim() === "")) {
              const [tplRow] = await ctx.db
                .select({ endpointUrl: destinationTemplates.endpointUrl })
                .from(destinationTemplates)
                .where(eq(destinationTemplates.id, tw.templateId))
                .limit(1);
              ep = tplRow?.endpointUrl;
              urlLogSource = "destination_templates";
            }
            if (
              process.env.STAGE2_DYNAMIC_TEMPLATE_LOG === "1" ||
              process.env.STAGE2_DYNAMIC_TEMPLATE_LOG === "true"
            ) {
              console.log("[stage2:dynamicTemplate] order log targetUrl source=", urlLogSource, {
                targetId: tw.id,
                templateId: tw.templateId,
                actionId: tw.actionId,
              });
            }
            targetUrlUsed =
              ep != null && typeof ep === "string" && ep.trim().length > 0
                ? ep.trim()
                : undefined;
          } catch {
            targetUrlUsed = undefined;
          }
        }
      }
      adapterInput = {
        db: ctx.db,
        targetWebsite: tw,
        variableFields,
        connection,
        userId: ctx.userId,
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

    case "http-api-key": {
      adapterInput = {
        appKey: tw?.appKey ?? null,
        templateConfig: tw?.templateConfig,
        leadRow,
        db: ctx.db,
        userId: ctx.userId,
        connectionId: tw?.connectionId ?? null,
      };
      break;
    }

    case "http-oauth2": {
      adapterInput = {
        appKey: tw?.appKey ?? null,
        templateConfig: tw?.templateConfig,
        leadRow,
        db: ctx.db,
        userId: ctx.userId,
        connectionId: tw?.connectionId ?? null,
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

  // Sprint 1 / Item 1.3 — circuit breaker removed.
  //
  // The previous in-memory `circuitBreakerService` was per-process: under a
  // multi-worker deploy (Railway autoscale, K8s replicas) every worker held
  // an independent CLOSED state, so the threshold of 5 failures would be hit
  // N times in parallel before any worker started rejecting — exactly the
  // amplification it was meant to prevent. The adapters themselves already
  // back off on 429 (Retry-After header) and the retry scheduler escalates
  // delays for repeated failures, which together cover the legitimate
  // protection use case at a process-local level.
  //
  // If durable distributed circuit protection is needed later, move state
  // to Redis (BullMQ already has a connection) — DO NOT re-introduce
  // in-memory.
  const result = await adapter.send(adapterInput, leadPayload);

  return { ...result, adapterKey, targetUrlUsed };
}

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

import type { DbClient } from "../db";
import type { leads, targetWebsites } from "../../drizzle/schema";
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

  let adapterInput: unknown;
  let targetUrlUsed: string | undefined;

  switch (adapterKey) {
    case "affiliate": {
      adapterInput = cfg;
      break;
    }

    case "dynamic-template": {
      adapterInput = { db: ctx.db, targetWebsite: tw, variableFields };
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

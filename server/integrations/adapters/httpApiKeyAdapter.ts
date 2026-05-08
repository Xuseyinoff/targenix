/**
 * httpApiKeyAdapter — Phase 9 generic HTTP delivery adapter.
 *
 * Handles any app with adapterKey === "http-api-key":
 *   1. Loads the api_key connection → decrypts the stored API key.
 *   2. Expands {{variable}} placeholders in templateConfig string values
 *      using lead data as context.
 *   3. Builds and sends an HTTP request according to the app manifest's
 *      executionEndpoint descriptor (URL, method, contentType, authScheme).
 *
 * Never throws — all errors are returned as DeliveryResult { success: false }.
 */

import { eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import { decrypt } from "../../encryption";
import { injectVariables, type LeadPayload } from "../../services/affiliateService";
import type { DbClient } from "../../db";
import type { DeliveryResult } from "../types";
import { getApp } from "../appRegistry";
import type { AppExecutionEndpoint } from "../manifest";

// ─── Config shape (injected by dispatchDelivery) ──────────────────────────────

interface HttpApiKeyAdapterConfig {
  appKey: string | null | undefined;
  templateConfig: Record<string, unknown> | null | undefined;
  leadRow: Record<string, unknown>;
  db?: DbClient;
  userId?: number;
  connectionId?: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadApiKey(
  db: DbClient | undefined,
  userId: number | undefined,
  connectionId: number | null | undefined,
): Promise<{ apiKey: string } | { error: string }> {
  if (!db || !connectionId || typeof userId !== "number") {
    return { error: "connectionId is required for http-api-key apps" };
  }

  try {
    const [row] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    if (!row) return { error: `Connection ${connectionId} not found` };
    if (row.userId !== userId) return { error: `Connection ${connectionId} ownership mismatch` };
    if (row.status !== "active") return { error: `Connection ${connectionId} is ${row.status}` };

    const creds = (row.credentialsJson ?? {}) as Record<string, unknown>;
    const encrypted = typeof creds.apiKeyEncrypted === "string" ? creds.apiKeyEncrypted : null;
    if (!encrypted) return { error: "Connection has no apiKeyEncrypted credential" };

    const apiKey = decrypt(encrypted);
    return { apiKey };
  } catch (err) {
    return { error: `Failed to load connection: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function buildLeadContext(lead: LeadPayload, leadRow: Record<string, unknown>): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (lead.fullName)  ctx.full_name = ctx.name = lead.fullName;
  if (lead.phone)     ctx.phone = ctx.phone_number = lead.phone;
  if (lead.email)     ctx.email = lead.email;
  const pageName     = typeof leadRow.pageName     === "string" ? leadRow.pageName     : "";
  const formName     = typeof leadRow.formName     === "string" ? leadRow.formName     : "";
  const campaignName = typeof leadRow.campaignName === "string" ? leadRow.campaignName : "";
  const createdAt    = leadRow.createdAt instanceof Date ? leadRow.createdAt.toLocaleString("uz-UZ") : "";
  if (pageName)     ctx.pageName     = pageName;
  if (formName)     ctx.formName     = formName;
  if (campaignName) ctx.campaignName = campaignName;
  if (createdAt)    ctx.createdAt    = createdAt;
  Object.assign(ctx, lead.extraFields ?? {});
  return ctx;
}

/** Expand all string values in templateConfig using context, skip connectionId. */
function expandConfig(
  templateConfig: Record<string, unknown>,
  context: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(templateConfig)) {
    if (key === "connectionId") continue;
    result[key] = typeof value === "string" ? injectVariables(value, context) : String(value ?? "");
  }
  return result;
}

function buildAuthHeader(
  scheme: string | undefined,
  apiKey: string,
): Record<string, string> {
  if (!scheme || scheme === "bearer") {
    return { Authorization: `Bearer ${apiKey}` };
  }
  if (scheme === "basic") {
    return { Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}` };
  }
  if (scheme.startsWith("header:")) {
    const headerName = scheme.slice("header:".length);
    return { [headerName]: apiKey };
  }
  // body:field — handled separately, not a header
  return {};
}

// ─── Main adapter ─────────────────────────────────────────────────────────────

export const httpApiKeyAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const opts = config as HttpApiKeyAdapterConfig;
    const templateConfig = (opts.templateConfig ?? {}) as Record<string, unknown>;

    // Resolve connectionId: prefer explicit field, fall back to templateConfig
    const connectionId =
      opts.connectionId ??
      (typeof templateConfig.connectionId === "number" ? templateConfig.connectionId : null);

    // Look up execution endpoint from manifest
    const manifest = opts.appKey ? getApp(opts.appKey) : null;
    const endpoint: AppExecutionEndpoint = manifest?.executionEndpoint ?? { url: "" };

    if (!endpoint.url) {
      return {
        success: false,
        error: `App '${opts.appKey ?? "unknown"}' has no executionEndpoint.url configured`,
        errorType: "validation",
      };
    }

    const authScheme = endpoint.authScheme ?? "bearer";

    // Load API key — skip for no-auth apps (authScheme "none")
    let apiKey = "";
    if (authScheme !== "none") {
      const keyResult = await loadApiKey(opts.db, opts.userId, connectionId);
      if ("error" in keyResult) {
        return { success: false, error: keyResult.error, errorType: "validation" };
      }
      apiKey = keyResult.apiKey;
    }

    // Build context + expand template values
    const context = buildLeadContext(lead, opts.leadRow ?? {});
    const expanded = expandConfig(templateConfig, context);

    // Expand URL itself (in case it contains {{variables}})
    const url = injectVariables(endpoint.url, { ...context, ...expanded });
    const method = endpoint.method ?? "POST";
    const contentType = endpoint.contentType ?? "application/json";

    // Build auth headers (empty for "none")
    const authHeaders = authScheme !== "none" ? buildAuthHeader(authScheme, apiKey) : {};

    // Build body: merge expanded fields; inject auth key if body:field scheme
    const bodyFields: Record<string, string> = { ...expanded };
    if (authScheme.startsWith("body:")) {
      const fieldName = authScheme.slice("body:".length);
      bodyFields[fieldName] = apiKey;
    }

    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": contentType,
          ...authHeaders,
        },
        body: method !== "GET" ? JSON.stringify(bodyFields) : undefined,
        signal: AbortSignal.timeout(15_000),
      });

      const latencyMs = Date.now() - t0;
      let responseBody: unknown = null;
      try { responseBody = await res.json(); } catch { /* non-JSON response — ok */ }

      if (res.ok) {
        return {
          success: true,
          responseData: responseBody,
          durationMs: latencyMs,
        };
      }

      const errMsg =
        typeof responseBody === "object" && responseBody !== null
          ? JSON.stringify(responseBody).slice(0, 300)
          : `HTTP ${res.status}`;

      return {
        success: false,
        error: errMsg,
        errorType: res.status >= 400 && res.status < 500 ? "validation" : "network",
        responseData: responseBody,
        durationMs: latencyMs,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        errorType: "network",
        durationMs: Date.now() - t0,
      };
    }
  },
};

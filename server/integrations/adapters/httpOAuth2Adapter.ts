/**
 * httpOAuth2Adapter — OAuth2-powered HTTP delivery adapter.
 *
 * Handles HubSpot, Kommo (AmoCRM), Pipedrive and any future OAuth2 CRM.
 *
 * Flow:
 *   1. Loads the `connections` row → gets oauthTokenId + appKey.
 *   2. Retrieves a valid access token via getValidAccessToken() (auto-refreshes).
 *   3. Expands {{variable}} placeholders in templateConfig using lead data.
 *   4. Builds a CRM-specific request body based on appKey.
 *   5. POSTs to the executionEndpoint URL with Authorization: Bearer {token}.
 *
 * Never throws — all errors are returned as DeliveryResult { success: false }.
 */

import { eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import { injectVariables, type LeadPayload } from "../../services/affiliateService";
import { getValidAccessToken } from "../../oauth/getValidAccessToken";
import type { DbClient } from "../../db";
import type { DeliveryResult } from "../types";
import { getApp } from "../appRegistry";
import type { AppExecutionEndpoint } from "../manifest";
import { inferDeliveryErrorType, parseRetryAfterHeader } from "../../lib/orderRetryPolicy";
import { assertSafeOutboundUrl } from "../../lib/urlSafety";
import { readBoundedJson } from "../../lib/fetchBounded";

// ─── Config shape ─────────────────────────────────────────────────────────────

interface HttpOAuth2AdapterConfig {
  appKey: string | null | undefined;
  templateConfig: Record<string, unknown> | null | undefined;
  leadRow: Record<string, unknown>;
  db: DbClient;
  userId: number;
  connectionId: number | null | undefined;
}

// ─── Token loader ─────────────────────────────────────────────────────────────

async function loadOAuthAccessToken(
  db: DbClient,
  userId: number,
  connectionId: number,
): Promise<{ accessToken: string } | { error: string }> {
  try {
    const [row] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    if (!row) return { error: `Connection ${connectionId} not found` };
    if (row.userId !== userId) return { error: `Connection ${connectionId} ownership mismatch` };
    if (row.status !== "active") return { error: `Connection ${connectionId} is ${row.status}` };
    if (!row.oauthTokenId) return { error: `Connection ${connectionId} has no OAuth token linked` };

    const connectionAppKey = (row.appKey ?? row.type) as string;
    const accessToken = await getValidAccessToken(db, {
      userId,
      appKey: connectionAppKey,
      oauthTokenId: row.oauthTokenId,
    });
    return { accessToken };
  } catch (err) {
    return {
      error: `Failed to get OAuth token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Lead context + config expansion ─────────────────────────────────────────

function buildLeadContext(
  lead: LeadPayload,
  leadRow: Record<string, unknown>,
): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (lead.fullName) ctx.full_name = ctx.name = lead.fullName;
  if (lead.phone) ctx.phone = ctx.phone_number = lead.phone;
  if (lead.email) ctx.email = lead.email;
  const pageName = typeof leadRow.pageName === "string" ? leadRow.pageName : "";
  const formName = typeof leadRow.formName === "string" ? leadRow.formName : "";
  const campaignName = typeof leadRow.campaignName === "string" ? leadRow.campaignName : "";
  const createdAt = leadRow.createdAt instanceof Date ? leadRow.createdAt.toLocaleString("uz-UZ") : "";
  if (pageName) ctx.pageName = pageName;
  if (formName) ctx.formName = formName;
  if (campaignName) ctx.campaignName = campaignName;
  if (createdAt) ctx.createdAt = createdAt;
  Object.assign(ctx, lead.extraFields ?? {});
  return ctx;
}

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

// ─── CRM-specific body builders ───────────────────────────────────────────────

function buildBody(appKey: string, expanded: Record<string, string>): unknown {
  switch (appKey) {
    case "hubspot": {
      const props: Record<string, string> = { hs_lead_status: "NEW" };
      if (expanded.firstname) props.firstname = expanded.firstname;
      if (expanded.phone) props.phone = expanded.phone;
      if (expanded.email) props.email = expanded.email;
      if (expanded.company) props.company = expanded.company;
      return { properties: props };
    }

    case "kommo": {
      const contact: Record<string, unknown> = {};
      const nameParts = (expanded.name ?? "").trim().split(/\s+/).filter(Boolean);
      contact.first_name = nameParts[0] ?? "";
      if (nameParts.length > 1) contact.last_name = nameParts.slice(1).join(" ");

      const customFields: Array<Record<string, unknown>> = [];
      if (expanded.phone) {
        customFields.push({
          field_code: "PHONE",
          values: [{ value: expanded.phone, enum_code: "WORK" }],
        });
      }
      if (expanded.email) {
        customFields.push({
          field_code: "EMAIL",
          values: [{ value: expanded.email, enum_code: "WORK" }],
        });
      }
      if (customFields.length) contact.custom_fields_values = customFields;

      const lead: Record<string, unknown> = {
        name: expanded.lead_name || expanded.name || "Lead",
        _embedded: { contacts: [contact] },
      };
      const pipelineId = Number(expanded.pipeline_id);
      if (!isNaN(pipelineId) && pipelineId > 0) lead.pipeline_id = pipelineId;
      const statusId = Number(expanded.status_id);
      if (!isNaN(statusId) && statusId > 0) lead.status_id = statusId;
      const responsibleUserId = Number(expanded.responsible_user_id);
      if (!isNaN(responsibleUserId) && responsibleUserId > 0)
        lead.responsible_user_id = responsibleUserId;

      return [lead];
    }

    case "pipedrive": {
      const body: Record<string, unknown> = {
        name: expanded.name || "New Person",
      };
      if (expanded.phone) {
        body.phone = [{ value: expanded.phone, primary: true, label: "work" }];
      }
      if (expanded.email) {
        body.email = [{ value: expanded.email, primary: true, label: "work" }];
      }
      const ownerId = Number(expanded.owner_id);
      if (!isNaN(ownerId) && ownerId > 0) body.owner_id = ownerId;
      return body;
    }

    default:
      return expanded;
  }
}

// ─── Main adapter ─────────────────────────────────────────────────────────────

export const httpOAuth2Adapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const opts = config as HttpOAuth2AdapterConfig;
    const appKey = opts.appKey ?? "";
    const templateConfig = (opts.templateConfig ?? {}) as Record<string, unknown>;

    const connectionId =
      opts.connectionId ??
      (typeof templateConfig.connectionId === "number" ? templateConfig.connectionId : null);

    if (!connectionId) {
      return {
        success: false,
        error: "connectionId is required for OAuth2 apps",
        errorType: "validation",
      };
    }

    const tokenResult = await loadOAuthAccessToken(opts.db, opts.userId, connectionId);
    if ("error" in tokenResult) {
      return { success: false, error: tokenResult.error, errorType: "validation" };
    }
    const { accessToken } = tokenResult;

    const manifest = appKey ? getApp(appKey) : null;
    const endpoint: AppExecutionEndpoint = manifest?.executionEndpoint ?? { url: "" };
    if (!endpoint.url) {
      return {
        success: false,
        error: `App '${appKey}' has no executionEndpoint.url configured`,
        errorType: "validation",
      };
    }

    const context = buildLeadContext(lead, opts.leadRow ?? {});
    const expanded = expandConfig(templateConfig, context);
    const url = injectVariables(endpoint.url, { ...context, ...expanded });
    const method = endpoint.method ?? "POST";
    const contentType = endpoint.contentType ?? "application/json";
    const body = buildBody(appKey, expanded);

    // SSRF guard: the executionEndpoint URL is partially user-controlled
    // (manifest may interpolate templateConfig values via injectVariables).
    // Refuse before sending if it resolves to localhost or a private IP.
    try {
      await assertSafeOutboundUrl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Refused outbound URL: ${msg}`,
        errorType: "validation",
      };
    }

    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": contentType,
          Authorization: `Bearer ${accessToken}`,
        },
        body: method !== "GET" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });

      const latencyMs = Date.now() - t0;
      let responseBody: unknown = null;
      try {
        responseBody = await readBoundedJson(res);
      } catch {
        /* oversize / non-JSON — ok */
      }

      if (res.ok) {
        return { success: true, responseData: responseBody, durationMs: latencyMs };
      }

      const errMsg =
        typeof responseBody === "object" && responseBody !== null
          ? JSON.stringify(responseBody).slice(0, 300)
          : `HTTP ${res.status}`;

      const inferred = inferDeliveryErrorType({ httpStatus: res.status, message: errMsg });
      const errorType =
        inferred ?? (res.status >= 400 && res.status < 500 ? "validation" : "network");
      const retryAfterMs = res.status === 429 ? parseRetryAfterHeader(res.headers) : undefined;

      return {
        success: false,
        error: errMsg,
        errorType,
        responseData: responseBody,
        durationMs: latencyMs,
        retryAfterMs,
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

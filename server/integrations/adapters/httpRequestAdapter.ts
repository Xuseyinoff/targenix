/**
 * httpRequestAdapter — delivery adapter for the universal `http-request` app.
 *
 * Consolidates the behaviour of:
 *   - `plainUrlAdapter` (custom URL + headers, no auth)
 *   - `httpApiKeyAdapter` (Bearer / API-key / Basic via the connection table)
 *
 * The new adapter reads everything from `templateConfig` (the row stored on
 * `destinations`) so a destination is self-contained — no separate
 * connection row is required. Connection-backed flows (when an API key is
 * shared across many destinations) will be threaded in via the optional
 * `connectionId` route in a later iteration; for now the adapter is
 * inline-secret-only, which mirrors what `plain-url` users already do
 * manually with the Authorization header.
 *
 * Variable expansion follows the same `{{key}}` syntax already used across
 * the codebase — `full_name`, `phone_number`, `email`, `pageName`,
 * `formName`, `campaignName`, `createdAt`, plus any custom `extraFields`.
 */

import axios, { type AxiosRequestConfig } from "axios";
import { injectVariables, type LeadPayload } from "../../services/affiliateService";
import { assertSafeOutboundUrl } from "../../lib/urlSafety";
import { inferDeliveryErrorType, parseRetryAfterHeader } from "../../lib/orderRetryPolicy";
import type { DeliveryResult } from "../types";

// ─── Config shape (matches the http-request manifest) ────────────────────

type AuthScheme = "none" | "bearer" | "api_key_header" | "basic";

interface AuthenticationGroup {
  scheme?: AuthScheme;
  bearerToken?: string;
  apiKeyHeader?: string;
  apiKeyValue?: string;
  basicUsername?: string;
  basicPassword?: string;
}

interface BodyGroup {
  contentType?: "json" | "form-urlencoded" | "multipart";
  bodyTemplate?: string;
  bodyFields?: Array<{ key: string; value: string }>;
}

interface AdvancedGroup {
  headers?: Array<{ name: string; value: string }>;
  queryParams?: Array<{ name: string; value: string }>;
}

interface HttpRequestConfig {
  url: string;
  method?: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  authentication?: AuthenticationGroup;
  bodyGroup?: BodyGroup;
  advanced?: AdvancedGroup;
  /** Lead row (passed by dispatch) — used to build the variable context. */
  leadRow?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildContext(
  lead: LeadPayload,
  leadRow: Record<string, unknown> | undefined,
): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (lead.fullName) ctx.full_name = ctx.name = lead.fullName;
  if (lead.phone) ctx.phone = ctx.phone_number = lead.phone;
  if (lead.email) ctx.email = lead.email;
  if (lead.leadgenId) ctx.leadgen_id = lead.leadgenId;
  if (lead.pageId) ctx.page_id = lead.pageId;
  if (lead.formId) ctx.form_id = lead.formId;

  const row = leadRow ?? {};
  if (typeof row.pageName === "string") ctx.pageName = row.pageName;
  if (typeof row.formName === "string") ctx.formName = row.formName;
  if (typeof row.campaignName === "string") ctx.campaignName = row.campaignName;
  if (row.createdAt instanceof Date) ctx.createdAt = row.createdAt.toLocaleString("uz-UZ");

  if (lead.extraFields) Object.assign(ctx, lead.extraFields);
  return ctx;
}

function applyAuthentication(
  auth: AuthenticationGroup | undefined,
  headers: Record<string, string>,
  ctx: Record<string, string>,
): void {
  const scheme = auth?.scheme ?? "none";
  if (scheme === "none") return;

  if (scheme === "bearer" && auth?.bearerToken) {
    headers["Authorization"] = `Bearer ${injectVariables(auth.bearerToken, ctx)}`;
    return;
  }
  if (scheme === "api_key_header" && auth?.apiKeyHeader && auth?.apiKeyValue) {
    headers[auth.apiKeyHeader] = injectVariables(auth.apiKeyValue, ctx);
    return;
  }
  if (scheme === "basic" && auth?.basicUsername) {
    const u = injectVariables(auth.basicUsername, ctx);
    const p = injectVariables(auth.basicPassword ?? "", ctx);
    headers["Authorization"] = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
    return;
  }
}

function renderQueryString(
  params: Array<{ name: string; value: string }> | undefined,
  ctx: Record<string, string>,
): string {
  if (!params || params.length === 0) return "";
  const usp = new URLSearchParams();
  for (const { name, value } of params) {
    if (!name) continue;
    usp.append(name, injectVariables(value ?? "", ctx));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function renderHeaders(
  list: Array<{ name: string; value: string }> | undefined,
  ctx: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!list) return out;
  for (const { name, value } of list) {
    if (!name) continue;
    out[name] = injectVariables(value ?? "", ctx);
  }
  return out;
}

interface BuiltBody {
  body: string | URLSearchParams | undefined;
  contentType: string;
}

function buildBody(group: BodyGroup | undefined, ctx: Record<string, string>): BuiltBody {
  const contentType = group?.contentType ?? "json";

  if (contentType === "json") {
    const template = group?.bodyTemplate ?? "";
    const rendered = injectVariables(template, ctx);
    return { body: rendered, contentType: "application/json" };
  }
  if (contentType === "form-urlencoded") {
    const usp = new URLSearchParams();
    for (const { key, value } of group?.bodyFields ?? []) {
      if (!key) continue;
      usp.append(key, injectVariables(value ?? "", ctx));
    }
    return { body: usp, contentType: "application/x-www-form-urlencoded" };
  }
  if (contentType === "multipart") {
    // multipart needs FormData with Buffer fields; for the common lead
    // case (text-only fields) it's identical to URLSearchParams over the
    // wire. Full multipart with file parts is a follow-up.
    const usp = new URLSearchParams();
    for (const { key, value } of group?.bodyFields ?? []) {
      if (!key) continue;
      usp.append(key, injectVariables(value ?? "", ctx));
    }
    return { body: usp, contentType: "multipart/form-data" };
  }
  return { body: undefined, contentType: "application/json" };
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export const httpRequestAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const cfg = config as HttpRequestConfig;
    if (!cfg.url) {
      return { success: false, error: "URL is required", errorType: "validation" };
    }

    const method = (cfg.method ?? "POST").toUpperCase() as "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
    const ctx = buildContext(lead, cfg.leadRow);

    // Render URL + append query string.
    const renderedUrl = injectVariables(cfg.url, ctx);
    const query = renderQueryString(cfg.advanced?.queryParams, ctx);
    const finalUrl = `${renderedUrl}${query}`;

    try {
      await assertSafeOutboundUrl(finalUrl);
    } catch (err) {
      return {
        success: false,
        error: `Refused outbound URL: ${err instanceof Error ? err.message : String(err)}`,
        errorType: "validation",
      };
    }

    // Build headers: custom headers first, then auth (auth wins so users
    // can't accidentally leak a stale Authorization from the headers list).
    const headers = renderHeaders(cfg.advanced?.headers, ctx);
    applyAuthentication(cfg.authentication, headers, ctx);

    // Build body only when the method carries one.
    let body: BuiltBody = { body: undefined, contentType: "application/json" };
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = buildBody(cfg.bodyGroup, ctx);
      headers["Content-Type"] = body.contentType;
    }

    const t0 = Date.now();
    try {
      const axiosCfg: AxiosRequestConfig = {
        url: finalUrl,
        method,
        headers,
        data: body.body,
        timeout: 15_000,
        validateStatus: () => true,
      };
      const res = await axios.request(axiosCfg);
      const durationMs = Date.now() - t0;

      if (res.status >= 200 && res.status < 300) {
        return { success: true, responseData: res.data, durationMs };
      }

      const errMsg =
        typeof res.data === "object" && res.data !== null
          ? JSON.stringify(res.data).slice(0, 300)
          : `HTTP ${res.status}`;
      const inferred = inferDeliveryErrorType({ httpStatus: res.status, message: errMsg });
      const errorType =
        inferred ?? (res.status >= 400 && res.status < 500 ? "validation" : "network");
      const retryAfterMs =
        res.status === 429
          ? parseRetryAfterHeader(res.headers as unknown as Headers)
          : undefined;

      return {
        success: false,
        error: errMsg,
        errorType,
        responseData: res.data,
        durationMs,
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

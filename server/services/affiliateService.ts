import axios from "axios";
import FormData from "form-data";
import { decrypt } from "../encryption";
import type { DestinationTemplate } from "../../drizzle/schema";
import { inferDeliveryErrorType, type DeliveryErrorType } from "../lib/orderRetryPolicy";

// ─── Shared lead payload ────────────────────────────────────────────────────
export interface LeadPayload {
  leadgenId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  pageId: string;
  formId: string;
  extraFields?: Record<string, string>;
}

export type AffiliateResult = {
  success: boolean;
  responseData?: unknown;
  error?: string;
  errorType?: DeliveryErrorType;
};

// ─── Template types ─────────────────────────────────────────────────────────
export type TemplateType = "custom";

/**
 * Config stored in targetWebsites.templateConfig per template.
 * apiKey is stored encrypted as apiKeyEncrypted; never stored plain.
 */
export interface SotuvchiConfig {
  apiKeyEncrypted?: string;
  offerId?: string;
  stream?: string;
}

export interface HundredKConfig {
  apiKeyEncrypted?: string;
  streamId?: string;
}

/**
 * Universal custom template config.
 * Supports JSON body template, key-value form fields, and multipart form data.
 */
export interface CustomConfig {
  url: string;
  method?: "POST" | "GET";
  headers?: Record<string, string>;
  /** Content type determines how the body is built */
  contentType?: "json" | "form-urlencoded" | "multipart" | "form"; // "form" kept for backward compat
  /**
   * JSON body template string with {{variable}} placeholders.
   * Used when contentType = "json".
   * Example: '{"name":"{{name}}","phone":"{{phone}}","offer_id":"{{offer_id}}"}'
   */
  bodyTemplate?: string;
  /**
   * Key-value pairs for form-urlencoded or multipart body.
   * Values support {{variable}} placeholders.
   * Used when contentType = "form-urlencoded" | "multipart".
   */
  bodyFields?: Array<{ key: string; value: string }>;
  /** Legacy field mapping (kept for backward compat) */
  fieldMap?: Record<string, string>;
  /**
   * Success condition:
   *   "http_2xx"   — HTTP 2xx response (default)
   *   "json_field" — JSON field check: jsonField == jsonValue
   *   "ok_true"    — legacy: response.ok === true
   *   "http_200"   — legacy alias for http_2xx
   */
  successCondition?: "http_2xx" | "json_field" | "ok_true" | "http_200" | string;
  /** Field name to check when successCondition = "json_field" */
  jsonField?: string;
  /** Expected value when successCondition = "json_field" */
  jsonValue?: string;
  variableFields?: string[];
}

export type TemplateConfig = SotuvchiConfig | HundredKConfig | CustomConfig;

// Legacy config (for old AFFILIATE integrations without templateType)
export interface AffiliateConfig {
  url: string;
  headers?: Record<string, string>;
  fieldMap?: Record<string, string>;
}

// ─── Built-in variable map ────────────────────────────────────────────────────
/**
 * Build the variable context from a lead payload.
 * These are the built-in {{variable}} values available in templates.
 */
export function buildVariableContext(
  lead: LeadPayload,
  extraVars: Record<string, string> = {}
): Record<string, string> {
  return {
    name: lead.fullName ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    lead_id: lead.leadgenId,
    page_id: lead.pageId,
    form_id: lead.formId,
    // User-defined extra field mappings (e.g. campaign_name, ad_id, static values)
    ...(lead.extraFields ?? {}),
    // Per-routing variable fields override extraFields if keys conflict
    ...extraVars,
  };
}

/**
 * Replace all {{variable}} placeholders in a string with values from the context.
 * Unknown variables are replaced with empty string.
 */
export function injectVariables(template: string, ctx: Record<string, string>): string {
  const safeCtx = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(ctx)) safeCtx[k] = v;
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim();
    if (!Object.prototype.hasOwnProperty.call(safeCtx, k)) return "";
    return safeCtx[k];
  });
}

/**
 * Resolve a template string that MAY contain both `{{SECRET:key}}` and
 * ordinary `{{variable}}` tokens in any combination.
 *
 * Resolution order is fixed — SECRET tokens first, then variables — so a
 * pattern like `"Bearer {{SECRET:api_key}} for {{name}}"` works in a
 * single call. Keeping that order matters: after SECRET substitution no
 * `{{SECRET:…}}` remains, and `injectVariables` (whose regex matches any
 * `{{…}}`) would otherwise treat the `SECRET:…` marker as an unknown
 * variable name and erase it.
 *
 * This helper is intentionally ADDITIVE: when the input has no
 * `{{SECRET:` substring it skips the SECRET pass and behaves byte-for-
 * byte like `injectVariables`. Existing plain-text and
 * `{{variable}}`-only configs therefore see no behaviour change.
 *
 * Failure modes — all resolve to empty string, never throw:
 *   - `secrets` is undefined
 *   - Secret key not present in the map
 *   - Stored ciphertext is malformed or decrypt() throws
 *
 * This mirrors the "unknown variable → empty string" contract of
 * `injectVariables`, so delivery can never be blocked by a missing or
 * corrupted secret — the partner endpoint will simply receive an empty
 * value and respond per its own validation.
 */
export function resolveTemplateValue(
  template: string,
  ctx: Record<string, string>,
  secrets?: Record<string, string>,
): string {
  if (typeof template !== "string") return template;

  // Fast path: no SECRET token present → preserve exact injectVariables
  // output for existing configs. This is the path 100% of current
  // production traffic takes. The probe mirrors the SECRET regex below
  // (whitespace after `{{` is allowed) so a stray space between the
  // braces and `SECRET:` does not silently bypass SECRET resolution and
  // fall through to injectVariables, which would then erase the token.
  if (!/\{\{\s*SECRET:/.test(template)) {
    return injectVariables(template, ctx);
  }

  const safeSecrets = secrets ?? {};
  const withSecrets = template.replace(
    /\{\{\s*SECRET:([^}]+)\}\}/g,
    (_match, rawKey: string) => {
      const key = rawKey.trim();
      const encrypted = safeSecrets[key];
      if (typeof encrypted !== "string" || encrypted.length === 0) return "";
      try {
        return decrypt(encrypted);
      } catch {
        return "";
      }
    },
  );

  return injectVariables(withSecrets, ctx);
}

/**
 * Extract all {{variable}} names from a template string.
 * Returns unique list of variable names.
 */
export function extractVariableNames(template: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const re = /\{\{([^}]+)\}\}/g;
  while ((m = re.exec(template)) !== null) names.add(m[1].trim());
  return Array.from(names);
}

/**
 * Extract custom (non-built-in) variable names from a template string.
 * Built-in: name, phone, email, lead_id, page_id, form_id
 */
export const BUILTIN_VARIABLES = new Set(["name", "phone", "email", "lead_id", "page_id", "form_id"]);

export function extractCustomVariableNames(template: string): string[] {
  return extractVariableNames(template).filter((v) => !BUILTIN_VARIABLES.has(v));
}

// ─── Helper: decrypt apiKey from stored config ───────────────────────────────
function getApiKey(config: Record<string, unknown>): string {
  if (typeof config.apiKeyEncrypted === "string") {
    try { return decrypt(config.apiKeyEncrypted); } catch { return ""; }
  }
  return "";
}

// ─── Evaluate success condition ───────────────────────────────────────────────
function evaluateSuccess(
  cfg: Record<string, unknown>,
  status: number,
  data: unknown
): boolean {
  const cond = (cfg.successCondition as string | undefined) ?? "http_2xx";

  if (cond === "http_2xx" || cond === "http_200") {
    return status >= 200 && status < 300;
  }

  if (cond === "ok_true") {
    if (typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      return d.ok === "true" || d.ok === true;
    }
    return false;
  }

  if (cond === "json_field") {
    const field = cfg.jsonField as string | undefined;
    const expected = cfg.jsonValue as string | undefined;
    if (!field || !expected) return status >= 200 && status < 300;
    if (typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      return String(d[field]) === expected;
    }
    return false;
  }

  // Fallback
  return status >= 200 && status < 300;
}

// ─── Build custom request body ────────────────────────────────────────────────
/**
 * Build the request body for a custom template based on contentType.
 * Returns { body, contentTypeHeader, formData? }
 */
export function buildCustomBody(
  cfg: Record<string, unknown>,
  varCtx: Record<string, string>
): {
  body: string | Record<string, unknown> | null;
  contentTypeHeader: string;
  formData?: FormData;
} {
  const ct = (cfg.contentType as string | undefined) ?? "json";
  const normalizedCt = ct === "form" ? "form-urlencoded" : ct; // backward compat
  // Secrets map may or may not exist. `resolveTemplateValue` treats a
  // missing / empty map exactly like `injectVariables` treated a missing
  // variable — returns empty string — so existing plain-text configs
  // behave byte-for-byte identically to before.
  const secrets = (cfg.secrets as Record<string, string> | undefined) ?? {};

  if (normalizedCt === "json") {
    const bodyTemplate = (cfg.bodyTemplate as string | undefined) ?? "";
    if (bodyTemplate.trim()) {
      // Resolve SECRET tokens (if any) then inject variables. Without a
      // `{{SECRET:…}}` marker this is identical to `injectVariables`.
      const injected = resolveTemplateValue(bodyTemplate, varCtx, secrets);
      try {
        const parsed = JSON.parse(injected);
        return { body: parsed, contentTypeHeader: "application/json" };
      } catch {
        // If JSON parse fails after injection, return as string (will be sent as-is)
        return { body: injected, contentTypeHeader: "application/json" };
      }
    }
    // Legacy: fieldMap-based JSON body
    const fieldMap = cfg.fieldMap as Record<string, string> | undefined;
    if (fieldMap) {
      const mapped: Record<string, string> = {};
      for (const [apiKey, varName] of Object.entries(fieldMap)) {
        mapped[apiKey] = varCtx[varName] ?? varCtx[apiKey] ?? "";
      }
      return { body: mapped, contentTypeHeader: "application/json" };
    }
    // Default: send all built-in variables
    return {
      body: {
        name: varCtx.name,
        phone: varCtx.phone,
        email: varCtx.email,
        lead_id: varCtx.lead_id,
        page_id: varCtx.page_id,
        form_id: varCtx.form_id,
      },
      contentTypeHeader: "application/json",
    };
  }

  if (normalizedCt === "form-urlencoded") {
    const bodyFields = cfg.bodyFields as Array<{ key: string; value: string }> | undefined;
    const params = new URLSearchParams();
    if (bodyFields?.length) {
      for (const { key, value } of bodyFields) {
        if (key) params.append(key, resolveTemplateValue(value, varCtx, secrets));
      }
    } else {
      // Legacy: fieldMap
      const fieldMap = cfg.fieldMap as Record<string, string> | undefined;
      if (fieldMap) {
        for (const [apiKey, varName] of Object.entries(fieldMap)) {
          params.append(apiKey, varCtx[varName] ?? varCtx[apiKey] ?? "");
        }
      } else {
        params.append("name", varCtx.name);
        params.append("phone", varCtx.phone);
        params.append("email", varCtx.email);
      }
    }
    return { body: params.toString(), contentTypeHeader: "application/x-www-form-urlencoded" };
  }

  if (normalizedCt === "multipart") {
    const bodyFields = cfg.bodyFields as Array<{ key: string; value: string }> | undefined;
    const fd = new FormData();
    if (bodyFields?.length) {
      for (const { key, value } of bodyFields) {
        if (key) fd.append(key, resolveTemplateValue(value, varCtx, secrets));
      }
    } else {
      fd.append("name", varCtx.name);
      fd.append("phone", varCtx.phone);
      fd.append("email", varCtx.email);
    }
    return { body: null, contentTypeHeader: "multipart/form-data", formData: fd };
  }

  // Fallback: JSON
  return { body: varCtx, contentTypeHeader: "application/json" };
}

/**
 * Build the request body for a destination template configured with bodyFields.
 * Supports secret fields, lead fields, routing variables, and static values.
 */
export function buildBody(
  template: DestinationTemplate,
  targetWebsite: { templateConfig?: unknown },
  lead: LeadPayload,
  variables: Record<string, string> = {}
): Record<string, string> {
  const body: Record<string, string> = {};
  const cfg = (targetWebsite.templateConfig ?? {}) as Record<string, unknown>;
  const secrets = (cfg.secrets as Record<string, string> | undefined) ?? {};

  for (const field of template.bodyFields as Array<{ key: string; value: string }>) {
    if (!field.key) continue;
    const value = field.value ?? "";

    if (value.startsWith("{{SECRET:") && value.endsWith("}}")) {
      const secretKey = value.replace("{{SECRET:", "").replace("}}", "").trim();
      const encrypted = secrets[secretKey];
      if (encrypted) {
        try {
          body[field.key] = decrypt(encrypted);
        } catch {
          body[field.key] = "";
        }
      } else {
        body[field.key] = "";
      }
      continue;
    }

    if (value === "{{name}}") {
      body[field.key] = lead.fullName ?? "";
    } else if (value === "{{phone}}") {
      body[field.key] = lead.phone ?? "";
    } else if (value === "{{email}}") {
      body[field.key] = lead.email ?? "";
    } else if (value.startsWith("{{") && value.endsWith("}}")) {
      const varKey = value.replace("{{", "").replace("}}", "").trim();
      body[field.key] = variables[varKey] ?? "";
    } else {
      body[field.key] = value;
    }
  }

  return body;
}

// ─── Inject variables into headers ───────────────────────────────────────────
/**
 * Build outbound request headers from a template config, expanding both
 * `{{variable}}` and `{{SECRET:key}}` tokens exactly like
 * `buildCustomBody` does. Without a `{{SECRET:` marker the output is
 * byte-for-byte identical to the pre-Stage-D behaviour.
 *
 * Exported so unit tests can exercise SECRET resolution in headers
 * directly (the network-invoking caller `sendAffiliateOrderByTemplate`
 * is harder to isolate); no production caller outside this module reads
 * this export.
 */
export function buildHeaders(
  cfg: Record<string, unknown>,
  varCtx: Record<string, string>,
  contentTypeHeader: string
): Record<string, string> {
  const rawHeaders = (cfg.headers as Record<string, string> | undefined) ?? {};
  const secrets = (cfg.secrets as Record<string, string> | undefined) ?? {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    result[k] = resolveTemplateValue(v, varCtx, secrets);
  }
  // Set Content-Type unless overridden by user
  if (!result["Content-Type"] && !result["content-type"]) {
    result["Content-Type"] = contentTypeHeader;
  }
  return result;
}

import { assertSafeOutboundUrl } from "../lib/urlSafety";

// ─── Main dispatcher ─────────────────────────────────────────────────────────
/**
 * Send a lead to a target website using its template config.
 *
 * @param templateType  The template type (custom)
 * @param templateConfig  The stored config from targetWebsites.templateConfig (may contain apiKeyEncrypted)
 * @param lead  The lead payload
 * @param variableFields  Per-routing variable fields (offer_id, stream, stream_id, custom vars, etc.)
 */
export async function sendAffiliateOrderByTemplate(
  templateType: TemplateType,
  templateConfig: unknown,
  lead: LeadPayload,
  variableFields: Record<string, string> = {},
  /** URL from the target_websites.url DB column (for custom templates) */
  siteUrl?: string
): Promise<AffiliateResult> {
  const cfg = (templateConfig ?? {}) as Record<string, unknown>;

  try {
    // ── custom ────────────────────────────────────────────────────────────────
    // URL priority: cfg.url (legacy) → siteUrl (from target_websites.url column)
    const url = (cfg.url as string) || siteUrl || "";
    if (!url) {
      return { success: false, error: "No URL configured for custom template", errorType: "validation" };
    }

    // SSRF protection: reject localhost, RFC1918, and non-HTTPS URLs before
    // issuing the outbound HTTP request. Without this, a user could point their
    // target website at an internal Railway service or cloud metadata endpoint.
    await assertSafeOutboundUrl(url);

    const method = (cfg.method as string) ?? "POST";

    // Build variable context: built-ins + per-routing custom vars
    const varCtx = buildVariableContext(lead, variableFields);

    // Build body
    const { body, contentTypeHeader, formData } = buildCustomBody(cfg, varCtx);

    // Build headers (with variable injection)
    const headers = buildHeaders(cfg, varCtx, contentTypeHeader);

    // Send request
    const response = await axios.request({
      url,
      method,
      data: formData ?? body,
      headers: formData ? { ...headers, ...formData.getHeaders() } : headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    const success = evaluateSuccess(cfg, response.status, response.data);
    if (!success) {
      const errMsg =
        typeof response.data === "string" && response.data.trim()
          ? response.data
          : `HTTP ${response.status}`;
      return {
        success: false,
        responseData: response.data,
        error: errMsg,
        errorType: inferDeliveryErrorType({ httpStatus: response.status, message: errMsg }),
      };
    }
    return { success: true, responseData: response.data };
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown; status?: number }; message?: string };
    const error = e?.response?.data ?? e?.message ?? "Unknown error";
    const errStr = JSON.stringify(error);
    console.error(`[Affiliate] Template ${templateType} failed:`, error);
    return {
      success: false,
      error: errStr,
      errorType:
        inferDeliveryErrorType({ httpStatus: e?.response?.status, message: errStr }) ?? "network",
    };
  }
}

// ─── Dynamic template lead delivery ──────────────────────────────────────────
/**
 * Send a lead to a destination configured from an admin-managed template.
 *
 * Template bodyFields value patterns:
 *   "{{SECRET:key}}"  → decrypt from targetWebsite.templateConfig.secrets[key]
 *   "{{name}}"        → use lead.fullName
 *   "{{phone}}"       → use lead.phone
 *   "{{offer_id}}"    → use integration variableValues[offer_id]
 *   "static value"    → use as-is (no {{ }})
 *
 * Multi-tenant safety: caller must ensure targetWebsite.userId === lead.userId.
 */
export async function sendLeadViaTemplate(
  template: DestinationTemplate,
  templateConfig: unknown,
  lead: LeadPayload,
  variableValues: Record<string, string> = {}
): Promise<AffiliateResult> {
  const cfg = (templateConfig ?? {}) as Record<string, unknown>;

  try {
    await assertSafeOutboundUrl(template.endpointUrl);

    // Build variable context from lead
    const varCtx = buildVariableContext(lead, variableValues);

    // Build the request body from template bodyFields
    const resolvedFields = buildBody(template, { templateConfig: cfg }, lead, variableValues);

    // Build request based on contentType
    const method = template.method ?? "POST";
    let body: string | Record<string, unknown> | null = null;
    let contentTypeHeader = template.contentType;
    let formData: FormData | undefined;

    const normalizedCt = template.contentType.toLowerCase();
    const bodyFieldsArr = template.bodyFields as Array<{ key: string; value: string }>;

    if (normalizedCt.includes("json")) {
      // Raw JSON template mode (stored as single __json_template__ entry)
      if (bodyFieldsArr.length === 1 && bodyFieldsArr[0].key === "__json_template__") {
        const secrets = (cfg.secrets as Record<string, string> | undefined) ?? {};
        let tpl = bodyFieldsArr[0].value;
        // Resolve {{SECRET:key}} substitutions
        tpl = tpl.replace(/\{\{SECRET:([^}]+)\}\}/g, (_, key: string) => {
          const encrypted = secrets[key.trim()];
          if (!encrypted) return "";
          try { return decrypt(encrypted); } catch { return ""; }
        });
        // Resolve {{variable}} substitutions
        tpl = injectVariables(tpl, varCtx);
        body = tpl; // raw JSON string — axios sends as-is
      } else {
        body = resolvedFields; // flat object → axios JSON.stringifies
      }
      contentTypeHeader = "application/json";
    } else if (normalizedCt.includes("form-urlencoded") || normalizedCt.includes("urlencoded")) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(resolvedFields)) params.append(k, v);
      body = params.toString();
      contentTypeHeader = "application/x-www-form-urlencoded";
    } else if (normalizedCt.includes("multipart")) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(resolvedFields)) fd.append(k, v);
      formData = fd;
      contentTypeHeader = "multipart/form-data";
    } else {
      // Default: form-urlencoded
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(resolvedFields)) params.append(k, v);
      body = params.toString();
      contentTypeHeader = "application/x-www-form-urlencoded";
    }

    const headers: Record<string, string> = { "Content-Type": contentTypeHeader };

    const response = await axios.request({
      url: template.endpointUrl,
      method,
      data: formData ?? body,
      headers: formData ? { ...headers, ...formData.getHeaders() } : headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    const success = response.status >= 200 && response.status < 300;
    if (!success) {
      const errMsg = `HTTP ${response.status}`;
      return {
        success: false,
        responseData: response.data,
        error: errMsg,
        errorType: inferDeliveryErrorType({ httpStatus: response.status, message: errMsg }),
      };
    }
    return { success: true, responseData: response.data };
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown; status?: number }; message?: string };
    const error = e?.response?.data ?? e?.message ?? "Unknown error";
    const errStr = JSON.stringify(error);
    console.error(`[Affiliate] Dynamic template "${template.name}" failed:`, error);
    return {
      success: false,
      error: errStr,
      errorType:
        inferDeliveryErrorType({ httpStatus: e?.response?.status, message: errStr }) ?? "network",
    };
  }
}

// ─── Legacy sendAffiliateOrder (kept for backward compat) ───────────────────
export async function sendAffiliateOrder(
  config: AffiliateConfig,
  lead: LeadPayload
): Promise<AffiliateResult> {
  const customConfig: CustomConfig = {
    url: config.url,
    method: "POST",
    headers: config.headers,
    fieldMap: config.fieldMap,
    contentType: "json",
    successCondition: "http_2xx",
  };
  return sendAffiliateOrderByTemplate("custom", customConfig, lead, {});
}

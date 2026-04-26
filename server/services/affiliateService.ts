import axios from "axios";
import FormData from "form-data";
import { decrypt } from "../encryption";
import type { Connection, DestinationTemplate } from "../../drizzle/schema";
import { inferDeliveryErrorType, type DeliveryErrorType } from "../lib/orderRetryPolicy";
import { specIsAuthless } from "../integrations/connectionAppSpecs";
import { resolveSpecSafe } from "../integrations/listAppsSafe";
import type { DbClient } from "../db";
import { resolveMapping } from "../utils/resolveMapping";
import { transform } from "@shared/transformEngine";

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

// ─── Typed delivery errors ──────────────────────────────────────────────────
/**
 * Thrown by `resolveTemplateValue` when a `{{SECRET:key}}` token expansion
 * fails at the decrypt step — i.e. the ciphertext is stored in the secrets
 * map but `decrypt()` throws (malformed payload, key drift, corruption, …).
 *
 * Crucially this is NOT thrown for a *missing* secret key; that remains a
 * soft failure returning empty string, matching the existing
 * `{{unknown_variable}} → ""` contract of `injectVariables`.
 *
 * The distinction matters: a missing key is a configuration oversight that
 * the partner endpoint can still validate and reject; a decrypt failure on
 * an existing ciphertext means we have actual data corruption or key drift
 * and sending the request with an empty value would silently drop the lead.
 */
export class SecretDecryptError extends Error {
  readonly code = "SECRET_DECRYPT_FAILED" as const;
  readonly key: string;
  constructor(key: string, cause?: unknown) {
    super(`SECRET_DECRYPT_FAILED:${key}`);
    this.name = "SecretDecryptError";
    this.key = key;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Thrown by the legacy-template delivery path (`buildCustomBody` /
 * `buildHeaders`) when a `SecretDecryptError` bubbles up. It explicitly
 * blocks the outbound HTTP request — no axios call is made — so the
 * delivery is marked FAILED and the retry system can attempt again once
 * the underlying secret is re-encrypted with the current key.
 */
export class DeliveryBlockedError extends Error {
  readonly code = "DELIVERY_BLOCKED_SECRET_ERROR" as const;
  readonly key: string;
  readonly adapterContext: string;
  constructor(key: string, adapterContext: string, cause?: unknown) {
    super(`DELIVERY_BLOCKED_SECRET_ERROR:${key}@${adapterContext}`);
    this.name = "DeliveryBlockedError";
    this.key = key;
    this.adapterContext = adapterContext;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Thrown by `resolveSecretsForDelivery` when a destination is explicitly
 * linked to a `connections` row but that connection contains no secrets.
 * This is a loud signal that a user either never populated credentials or
 * the connection row is corrupted — refusing to silently proceed prevents
 * the class of silent-data-loss bug where an empty credential is sent.
 *
 * The accompanying error message intentionally avoids leaking any
 * secret-key names; the structured log emitted at the throw site
 * carries enough context (connectionId, templateId) for operators.
 */
export class ConnectionSecretMissingError extends Error {
  readonly code = "CONNECTION_SECRET_MISSING" as const;
  readonly connectionId: number;
  readonly templateId: number | null;
  constructor(connectionId: number, templateId: number | null) {
    super(
      `CONNECTION_SECRET_MISSING:connection=${connectionId}${
        templateId != null ? ` template=${templateId}` : ""
      }`,
    );
    this.name = "ConnectionSecretMissingError";
    this.connectionId = connectionId;
    this.templateId = templateId;
  }
}

/**
 * Thrown by `resolveSecretsForDelivery` when NO active connection is
 * attached to the destination.
 *
 * Distinct from `ConnectionSecretMissingError` by intent:
 *   - `CONNECTION_SECRET_MISSING` → "you linked a connection, but it has
 *     no secrets" (user action: fix/populate the connection).
 *   - `CONNECTION_REQUIRED`       → "this destination has no connection
 *     at all" (user action: create and link a connection via the wizard).
 */
export class ConnectionRequiredError extends Error {
  readonly code = "CONNECTION_REQUIRED" as const;
  readonly templateId: number | null;
  readonly userId: number | null;
  constructor(templateId: number | null, userId: number | null) {
    super(
      `CONNECTION_REQUIRED:${templateId != null ? `template=${templateId}` : "template=?"}${
        userId != null ? ` user=${userId}` : ""
      }`,
    );
    this.name = "ConnectionRequiredError";
    this.templateId = templateId;
    this.userId = userId;
  }
}

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
 * Evaluate all {{...}} expressions in a template string.
 * Supports plain variables ({{name}}) and transform functions
 * ({{upper(name)}}, {{concat(a, " ", b)}}, {{if(x == "y", "a", "b")}}, …).
 * Unknown variables and unknown functions both return "" (soft miss).
 */
export function injectVariables(template: string, ctx: Record<string, string>): string {
  return transform(template, ctx);
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
 * Failure modes — split into SOFT and HARD:
 *   SOFT (return empty string, mirrors `injectVariables`' unknown-variable
 *   contract — a configuration oversight that the partner endpoint can
 *   validate and reject on its own):
 *     - `secrets` is undefined
 *     - Secret key not present in the map
 *     - Stored ciphertext is the empty string
 *
 *   HARD (throw `SecretDecryptError`):
 *     - Ciphertext is present but `decrypt()` throws
 *       (malformed payload, key drift, data corruption)
 *
 * The hard failure existed silently before Stage D v3 — `decrypt()`
 * throwing was swallowed and an empty value was sent, so a key mismatch
 * during an encryption migration silently dropped every lead with a
 * "SENT" status. Throwing instead lets the calling layer block delivery
 * explicitly (FAILED + retryable) rather than lose the lead.
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
      // SOFT miss — no ciphertext stored under this key. Same semantics as
      // an unknown `{{variable}}`: return empty so plain-text configs and
      // misconfigured-but-not-corrupted secrets behave identically.
      if (typeof encrypted !== "string" || encrypted.length === 0) return "";
      try {
        return decrypt(encrypted);
      } catch (cause) {
        // HARD failure — signals key drift or corruption. Must stop
        // delivery; empty value here would be silently wrong.
        throw new SecretDecryptError(key, cause);
      }
    },
  );

  return injectVariables(withSecrets, ctx);
}

/**
 * Thin safety wrapper over `resolveTemplateValue` for the legacy-template
 * delivery path. Converts the raw `SecretDecryptError` into a
 * `DeliveryBlockedError` so callers upstream can distinguish "the
 * partner rejected our request" from "we refused to send the request".
 *
 * Structured log is emitted at the point of failure — before the error
 * is rewrapped — so operators can correlate the exact `key` and
 * `adapterContext` responsible without relying on the upstream
 * error-type classifier (`inferDeliveryErrorType`) preserving metadata.
 *
 * Any non-SecretDecrypt error is rethrown untouched (defence in depth —
 * we do not want to broaden the category of errors that translate into
 * "DELIVERY_BLOCKED_SECRET_ERROR", which has specific operational
 * meaning).
 */
function safeResolveForDelivery(
  template: string,
  ctx: Record<string, string>,
  secrets: Record<string, string>,
  adapterContext: string,
): string {
  try {
    return resolveTemplateValue(template, ctx, secrets);
  } catch (err) {
    if (err instanceof SecretDecryptError) {
      console.error("[affiliateService] SECRET_DECRYPT_FAILED", {
        code: err.code,
        key: err.key,
        adapterContext,
      });
      throw new DeliveryBlockedError(err.key, adapterContext, err);
    }
    throw err;
  }
}

/**
 * Pick the authoritative map of {{SECRET:key}} → <encrypted ciphertext>
 * for one outbound delivery.
 *
 * Decision order:
 *   1. `appKey` resolves to an auth-less spec → return `{}` immediately
 *      (no credentials needed).
 *   2. Active connection with a non-empty `credentialsJson.secretsEncrypted`
 *      map → return the connection's map (instant rotation on re-link).
 *   3. Active connection but `secretsEncrypted` is missing / empty →
 *      THROW `ConnectionSecretMissingError`.
 *   4. No active connection → THROW `ConnectionRequiredError`.
 *
 * The returned map always contains encrypted values; downstream resolvers
 * (`resolveTemplateValue`) handle decryption.
 */
export async function resolveSecretsForDelivery(opts: {
  connection?: Connection | null;
  templateConfig: Record<string, unknown> | null | undefined;
  templateId?: number | null;
  adapterContext: string;
  /**
   * Optional appKey of the template being delivered. When provided AND
   * it resolves to an auth-less spec (authType='none' or no sensitive
   * fields), this function short-circuits to `{}` — no connection
   * lookup, no fallback read, no CONNECTION_SECRET_MISSING possible.
   *
   * This is the runtime counterpart to `AUTH_NONE_HAS_SECRETS` in the
   * validator: together they make it impossible for an auth-less
   * template to need, carry, or surface credentials.
   */
  appKey?: string | null;
  /**
   * When set, `appKey` can resolve from the `apps` table (DB-only keys).
   * Omitted or null → spec lookup skips DB (DB-only apps will not resolve).
   */
  db?: DbClient | null;
  /** Tenant id — threaded to `ConnectionRequiredError` for operator diagnostics. */
  userId?: number | null;
}): Promise<Record<string, string>> {
  const {
    connection,
    templateConfig,
    templateId,
    adapterContext,
    appKey,
    db,
    userId,
  } = opts;
  if (appKey) {
    const spec = await resolveSpecSafe(db ?? null, appKey);
    if (spec && specIsAuthless(spec)) {
      return {};
    }
  }

  if (connection && connection.status === "active") {
    const creds = (connection.credentialsJson ?? {}) as Record<string, unknown>;
    const secretsFromConnection = creds.secretsEncrypted as
      | Record<string, string>
      | undefined;

    const hasAnySecret =
      !!secretsFromConnection &&
      typeof secretsFromConnection === "object" &&
      !Array.isArray(secretsFromConnection) &&
      Object.keys(secretsFromConnection).length > 0;

    if (hasAnySecret) {
      return secretsFromConnection;
    }

    console.error("[affiliateService] CONNECTION_SECRET_MISSING", {
      code: "CONNECTION_SECRET_MISSING",
      connectionId: connection.id,
      templateId: templateId ?? null,
      adapterContext,
    });
    throw new ConnectionSecretMissingError(connection.id, templateId ?? null);
  }

  // No active connection — every delivery must be backed by a connection.
  console.error("[affiliateService] CONNECTION_REQUIRED", {
    code: "CONNECTION_REQUIRED",
    templateId: templateId ?? null,
    userId: userId ?? null,
    adapterContext,
  });
  throw new ConnectionRequiredError(templateId ?? null, userId ?? null);
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
  varCtx: Record<string, string>,
  /** Pre-resolved secrets map from the linked `connections` row. */
  secretsOverride?: Record<string, string>,
): {
  body: string | Record<string, unknown> | null;
  contentTypeHeader: string;
  formData?: FormData;
} {
  const ct = (cfg.contentType as string | undefined) ?? "json";
  const normalizedCt = ct === "form" ? "form-urlencoded" : ct; // backward compat
  const secrets = secretsOverride ?? {};

  if (normalizedCt === "json") {
    const bodyTemplate = (cfg.bodyTemplate as string | undefined) ?? "";
    if (bodyTemplate.trim()) {
      // Resolve SECRET tokens (if any) then inject variables. Without a
      // `{{SECRET:…}}` marker this is identical to `injectVariables`.
      // `safeResolveForDelivery` escalates a SECRET decrypt failure into
      // `DeliveryBlockedError` so the outbound request is aborted before
      // any axios call is made.
      const injected = safeResolveForDelivery(
        bodyTemplate,
        varCtx,
        secrets,
        "legacy-template/body/json",
      );
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
        if (key)
          params.append(
            key,
            safeResolveForDelivery(
              value,
              varCtx,
              secrets,
              "legacy-template/body/form-urlencoded",
            ),
          );
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
        if (key)
          fd.append(
            key,
            safeResolveForDelivery(
              value,
              varCtx,
              secrets,
              "legacy-template/body/multipart",
            ),
          );
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
  lead: LeadPayload,
  variables: Record<string, string> = {},
  /** Pre-resolved secrets map from the linked `connections` row. */
  secretsOverride?: Record<string, string>,
): Record<string, string> {
  const body: Record<string, string> = {};
  const secrets = secretsOverride ?? {};

  for (const field of template.bodyFields as Array<{ key: string; value: string }>) {
    if (!field.key) continue;
    const value = field.value ?? "";

    if (value.startsWith("{{SECRET:") && value.endsWith("}}")) {
      const secretKey = value.replace("{{SECRET:", "").replace("}}", "").trim();
      const encrypted = secrets[secretKey];
      if (encrypted) {
        // Use safeResolveForDelivery so a decrypt failure throws DeliveryBlockedError
        // rather than silently sending an empty credential (same contract as buildCustomBody).
        body[field.key] = safeResolveForDelivery(
          value,
          {},
          secrets,
          "dynamic-template/body",
        );
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
  contentTypeHeader: string,
  /** Pre-resolved secrets map from the linked `connections` row. */
  secretsOverride?: Record<string, string>,
): Record<string, string> {
  const rawHeaders = (cfg.headers as Record<string, string> | undefined) ?? {};
  const secrets = secretsOverride ?? {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    // A failing SECRET in headers (e.g. Authorization) would previously
    // have been sent as empty, triggering silent 401/403 rejections and
    // data loss. `safeResolveForDelivery` now throws `DeliveryBlockedError`
    // before any axios call, so the upstream catch marks the delivery
    // FAILED and the retry system can re-attempt.
    result[k] = safeResolveForDelivery(
      v,
      varCtx,
      secrets,
      "legacy-template/headers",
    );
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
  siteUrl?: string,
  /** Active connection whose `credentialsJson.secretsEncrypted` is the secret source. */
  connection?: Connection | null,
  /** Tenant id — threaded to `resolveSecretsForDelivery` for error diagnostics. */
  userId?: number | null,
  /** Resolves `appKey` → spec for auth-less short-circuit (TS + `apps` table). */
  db?: DbClient | null,
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

    // Stage 2 — pick the secrets source BEFORE building body/headers so
    // both parts of the outbound request share a single authoritative
    // map. If a connection is linked but its credentials are missing
    // this throws `ConnectionSecretMissingError` and no axios call is
    // made (caught by the outer try/catch → failed delivery result).
    const secretsMap = await resolveSecretsForDelivery({
      connection: connection ?? null,
      templateConfig: cfg,
      templateId: null,
      adapterContext: "legacy-template",
      userId: userId ?? null,
      db: db ?? null,
    });

    // Build body
    const { body, contentTypeHeader, formData } = buildCustomBody(
      cfg,
      varCtx,
      secretsMap,
    );

    // Build headers (with variable injection)
    const headers = buildHeaders(cfg, varCtx, contentTypeHeader, secretsMap);

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
    // Stage 2 — surface CONNECTION_SECRET_MISSING as a validation-class
    // failure so the retry system treats it as a configuration problem
    // (needs user action) rather than a transient network blip.
    // NOTE: DeliveryBlockedError continues to flow through the generic
    // branch below (unchanged from Stage D v3) so error-classification
    // behaviour for existing tests / callers remains byte-for-byte the
    // same.
    if (
      err instanceof ConnectionSecretMissingError ||
      err instanceof ConnectionRequiredError
    ) {
      return {
        success: false,
        error: err.message,
        errorType: "validation",
      };
    }
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
 *   "{{SECRET:key}}"  → decrypt from the connection's secretsEncrypted map
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
  variableValues: Record<string, string> = {},
  /** Active connection whose `credentialsJson.secretsEncrypted` is the secret source. */
  connection?: Connection | null,
  /** Tenant id — threaded to `resolveSecretsForDelivery` for error diagnostics. */
  userId?: number | null,
  /** Resolves `appKey` → spec for auth-less short-circuit (TS + `apps` table). */
  db?: DbClient | null,
): Promise<AffiliateResult> {
  const cfg = (templateConfig ?? {}) as Record<string, unknown>;

  try {
    await assertSafeOutboundUrl(template.endpointUrl);

    // Build variable context from lead
    const varCtx = buildVariableContext(lead, variableValues);

    // Stage 2 — resolve secrets BEFORE building the body so any
    // CONNECTION_SECRET_MISSING failure short-circuits before we touch
    // axios. Same map is reused by the raw-JSON branch below.
    const secretsMap = await resolveSecretsForDelivery({
      connection: connection ?? null,
      templateConfig: cfg,
      templateId: template.id,
      adapterContext: "dynamic-template",
      appKey: template.appKey ?? null,
      userId: userId ?? null,
      db: db ?? null,
    });

    // Build the request body from template bodyFields
    const resolvedFields = buildBody(template, lead, variableValues, secretsMap);

    // D5 — optional mapping overlay for UI mapper. If present, it overrides/extends
    // resolvedFields without changing existing templates.
    const mapping = cfg.payloadMapping as Record<string, unknown> | undefined;
    const mapped = resolveMapping(mapping, lead);

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
        let tpl = bodyFieldsArr[0].value;
        // Use safeResolveForDelivery so a decrypt failure throws DeliveryBlockedError
        // instead of silently sending an empty credential (mirrors buildCustomBody contract).
        tpl = safeResolveForDelivery(tpl, varCtx, secretsMap, "dynamic-template/body/json-raw");
        // Resolve {{variable}} substitutions
        tpl = injectVariables(tpl, varCtx);
        body = tpl; // raw JSON string — axios sends as-is
      } else {
        body = { ...resolvedFields, ...mapped }; // flat object → axios JSON.stringifies
      }
      contentTypeHeader = "application/json";
    } else if (normalizedCt.includes("form-urlencoded") || normalizedCt.includes("urlencoded")) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...resolvedFields, ...mapped })) params.append(k, String(v));
      body = params.toString();
      contentTypeHeader = "application/x-www-form-urlencoded";
    } else if (normalizedCt.includes("multipart")) {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ ...resolvedFields, ...mapped })) fd.append(k, String(v));
      formData = fd;
      contentTypeHeader = "multipart/form-data";
    } else {
      // Default: form-urlencoded
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...resolvedFields, ...mapped })) params.append(k, String(v));
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
    // Stage 2 — a CONNECTION_SECRET_MISSING short-circuit is a config
    // error (the user linked a connection but never populated
    // credentials), NOT a network issue. Surface it with
    // `errorType: "validation"` so retry/backoff code treats it
    // accordingly and the dashboard can flag the affected
    // connection for re-entry.
    if (
      err instanceof ConnectionSecretMissingError ||
      err instanceof ConnectionRequiredError
    ) {
      return {
        success: false,
        error: err.message,
        errorType: "validation",
      };
    }
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

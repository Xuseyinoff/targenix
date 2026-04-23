import axios from "axios";
import FormData from "form-data";
import { decrypt } from "../encryption";
import type { Connection, DestinationTemplate } from "../../drizzle/schema";
import { inferDeliveryErrorType, type DeliveryErrorType } from "../lib/orderRetryPolicy";
import {
  getAppSpec,
  specIsAuthless,
} from "../integrations/connectionAppSpecs";
import { isConnectionSecretsOnlyEnabled } from "./featureFlags";

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
 * linked to a `connections` row (Stage 2: connection is the source of
 * truth) but that connection contains no secrets. This is a loud signal
 * that a user either never populated credentials or the connection row
 * is corrupted — in both cases we refuse to silently fall back to the
 * legacy per-destination `templateConfig.secrets`, because that would
 * restore the exact class of silent-data-loss bug Stage D v3 fixed.
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
 * Stage 3 — thrown by `resolveSecretsForDelivery` when the
 * `USE_CONNECTION_SECRETS_ONLY` feature flag is ON for the caller and
 * NO active connection is attached to the destination.
 *
 * Distinct from `ConnectionSecretMissingError` by intent:
 *   - `CONNECTION_SECRET_MISSING` → "you linked a connection, but it has
 *     no secrets" (user action: fix/populate the connection).
 *   - `CONNECTION_REQUIRED`       → "this destination has no connection
 *     at all" (user action: create a connection and link it, or
 *     re-create the destination via the connection-first wizard).
 *
 * Never thrown while the flag is OFF — the resolver falls back to
 * `templateConfig.secrets` and deliveries behave exactly as they did
 * pre-Stage-3. Flipping the flag is reversible at any time; no data
 * is deleted by this code path.
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
 * Stage 2 — runtime connection-based secret resolution.
 *
 * Picks the authoritative map of {{SECRET:key}} → <encrypted ciphertext>
 * for one outbound delivery, preferring the new `connections` store
 * over the legacy per-destination `target_websites.templateConfig.secrets`.
 *
 * Decision order:
 *   1. `connection` provided AND `status === 'active'` AND it carries a
 *      non-empty `credentialsJson.secretsEncrypted` map →
 *      return the connection's map (connection wins, instant rotation).
 *
 *   2. `connection` provided AND active BUT `secretsEncrypted` is
 *      missing / empty →
 *      THROW `ConnectionSecretMissingError`. The user explicitly linked
 *      a connection; silently falling back to `templateConfig.secrets`
 *      would mask a broken connection and ship stale credentials.
 *
 *   3. `connection` is `null` / `undefined` / not active →
 *      fall back to `templateConfig.secrets ?? {}`. Identical to the
 *      pre-Stage-2 path, so legacy destinations (no connectionId
 *      populated, or connection revoked / expired / errored) keep
 *      working byte-for-byte.
 *
 * The returned map ALWAYS contains encrypted values; downstream
 * resolvers (`resolveTemplateValue`) handle decryption and strict
 * error semantics.
 *
 * SECURITY: this helper does not itself decrypt anything — the
 * encryption boundary stays inside `resolveTemplateValue` /
 * `safeResolveForDelivery`.
 */
export function resolveSecretsForDelivery(opts: {
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
   * Stage 3 — tenant id, used strictly to evaluate the
   * `USE_CONNECTION_SECRETS_ONLY` feature flag. When omitted the flag
   * is treated as OFF for this call (conservative default: refusing
   * delivery for a caller we cannot identify would be worse than
   * letting the legacy path run). Tests use this to exercise the
   * pre- and post-flip semantics independently.
   */
  userId?: number | null;
}): Record<string, string> {
  const {
    connection,
    templateConfig,
    templateId,
    adapterContext,
    appKey,
    userId,
  } = opts;
  const cfg = (templateConfig ?? {}) as Record<string, unknown>;
  const fallbackSecrets =
    (cfg.secrets as Record<string, string> | undefined) ?? {};

  if (appKey) {
    const spec = getAppSpec(appKey);
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

  // Stage 3 — connection-only mode.
  //
  // No active connection bound to this destination. Under the new
  // contract this must NEVER happen once the flag is on for the
  // tenant: every delivery either carries an explicit connection or
  // is rejected at resolve-time, long before we build an HTTP body.
  //
  // Important: this branch runs AFTER the authless short-circuit
  // above, so auth-less templates stay untouched — those never need
  // a connection in the first place and flipping the flag would
  // otherwise be a surprise-break for them.
  if (isConnectionSecretsOnlyEnabled(userId ?? null)) {
    console.error("[affiliateService] CONNECTION_REQUIRED", {
      code: "CONNECTION_REQUIRED",
      templateId: templateId ?? null,
      userId: userId ?? null,
      adapterContext,
    });
    throw new ConnectionRequiredError(templateId ?? null, userId ?? null);
  }

  // Legacy path. Zero behaviour change when flag is off — this is the
  // byte-for-byte pre-Stage-3 branch, kept alive so old destinations
  // that still carry `templateConfig.secrets` continue to deliver
  // until Phase 3 migration links a connection to each of them.
  return fallbackSecrets;
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
  /**
   * Stage 2 — caller may pre-resolve the secrets map (e.g. from the
   * linked `connections` row). When provided it takes priority over
   * `cfg.secrets`; when omitted we fall back to the legacy
   * `cfg.secrets` path, so existing callers (preview endpoints, older
   * tests) keep working byte-for-byte.
   */
  secretsOverride?: Record<string, string>,
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
  const secrets =
    secretsOverride ??
    ((cfg.secrets as Record<string, string> | undefined) ?? {});

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
  targetWebsite: { templateConfig?: unknown },
  lead: LeadPayload,
  variables: Record<string, string> = {},
  /**
   * Stage 2 — optional pre-resolved secrets map from the linked
   * `connections` row. Takes priority over `templateConfig.secrets`
   * when present. Omitted by preview callers (targetWebsitesRouter
   * test endpoint) so those paths keep their legacy behaviour.
   */
  secretsOverride?: Record<string, string>,
): Record<string, string> {
  const body: Record<string, string> = {};
  const cfg = (targetWebsite.templateConfig ?? {}) as Record<string, unknown>;
  const secrets =
    secretsOverride ??
    ((cfg.secrets as Record<string, string> | undefined) ?? {});

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
  /**
   * Stage 2 — optional pre-resolved secrets map from the linked
   * `connections` row. Takes priority over `cfg.secrets` when present.
   */
  secretsOverride?: Record<string, string>,
): Record<string, string> {
  const rawHeaders = (cfg.headers as Record<string, string> | undefined) ?? {};
  const secrets =
    secretsOverride ??
    ((cfg.secrets as Record<string, string> | undefined) ?? {});
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
  /**
   * Stage 2 — optional linked `connections` row. When provided and
   * active, its `credentialsJson.secretsEncrypted` becomes the source
   * of truth for all `{{SECRET:key}}` resolutions in body + headers.
   * When absent we keep using `templateConfig.secrets` (legacy path).
   */
  connection?: Connection | null,
  /**
   * Stage 3 — tenant id for the delivery, used solely to evaluate the
   * `USE_CONNECTION_SECRETS_ONLY` feature flag. Optional so existing
   * call sites (retry workers, tests) keep working without changes.
   */
  userId?: number | null,
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
    const secretsMap = resolveSecretsForDelivery({
      connection: connection ?? null,
      templateConfig: cfg,
      templateId: null,
      adapterContext: "legacy-template",
      userId: userId ?? null,
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
  variableValues: Record<string, string> = {},
  /**
   * Stage 2 — optional linked `connections` row. Its
   * `credentialsJson.secretsEncrypted` map is the authoritative source
   * for `{{SECRET:key}}` substitutions when present and active.
   * Legacy destinations with no connection keep reading
   * `templateConfig.secrets` so existing deliveries are unaffected.
   */
  connection?: Connection | null,
  /**
   * Stage 3 — tenant id for the delivery, used solely to evaluate the
   * `USE_CONNECTION_SECRETS_ONLY` feature flag. Optional so existing
   * callers (retry workers, tests) keep working byte-for-byte.
   */
  userId?: number | null,
): Promise<AffiliateResult> {
  const cfg = (templateConfig ?? {}) as Record<string, unknown>;

  try {
    await assertSafeOutboundUrl(template.endpointUrl);

    // Build variable context from lead
    const varCtx = buildVariableContext(lead, variableValues);

    // Stage 2 — resolve secrets BEFORE building the body so any
    // CONNECTION_SECRET_MISSING failure short-circuits before we touch
    // axios. Same map is reused by the raw-JSON branch below.
    const secretsMap = resolveSecretsForDelivery({
      connection: connection ?? null,
      templateConfig: cfg,
      templateId: template.id,
      adapterContext: "dynamic-template",
      appKey: template.appKey ?? null,
      userId: userId ?? null,
    });

    // Build the request body from template bodyFields
    const resolvedFields = buildBody(
      template,
      { templateConfig: cfg },
      lead,
      variableValues,
      secretsMap,
    );

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
        // Stage 2 — the raw-JSON branch historically read
        // `cfg.secrets` directly. Now it reuses the resolved
        // `secretsMap` so connection-backed secrets flow through this
        // branch too. SOFT-miss semantics (missing key → empty) are
        // preserved; decrypt errors still silently return empty here
        // (pre-Stage-0 behaviour for this branch — tightening it is
        // out of Stage 2 scope per "do not touch encryption logic").
        let tpl = bodyFieldsArr[0].value;
        // Use safeResolveForDelivery so a decrypt failure throws DeliveryBlockedError
        // instead of silently sending an empty credential (mirrors buildCustomBody contract).
        tpl = safeResolveForDelivery(tpl, varCtx, secretsMap, "dynamic-template/body/json-raw");
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

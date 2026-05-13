/**
 * createPayload — pure helpers that translate `DynamicForm` values into the
 * shape expected by the `destinations.create` tRPC mutation.
 *
 * Extracted from `DestinationCreatorDrawer.tsx` so the mapping logic is:
 *   1. Unit-testable in isolation (no React / tRPC / toast dependencies).
 *   2. Reusable if we ever surface another inline-create flow (e.g. a
 *      `/destinations` modal that shares the same dynamic form engine).
 *
 * The build functions are intentionally strict: missing required fields
 * throw a descriptive Error that the caller can surface via toast. They do
 * NOT perform server-side validation — the router runs full zod parsing.
 */

import type { FieldValues } from "@/components/dynamic-form";

// ─── Supported app keys ──────────────────────────────────────────────────────

/**
 * Manifest `app.key` → `destinations.create` templateType. Apps not in
 * this map are rejected by `buildCreatePayload`.
 *
 * "http-api-key" entries use the generic handler below — no per-app branch
 * needed. Adding a new app only requires a server manifest + one line here.
 */
export const APP_KEY_TO_TEMPLATE_TYPE = {
  // Dedicated template types
  telegram:        "telegram",
  "google-sheets": "google-sheets",
  // HTTP API-key apps — all routed through the generic http-api-key handler
  "eskiz-sms":     "http-api-key",
  "playmobile-sms":"http-api-key",
  "openai":        "http-api-key",
  "bitrix24":      "http-api-key",
  "amocrm":        "http-api-key",
  // OAuth2 CRM apps — same templateType; adapter resolved by appKey at delivery
  "hubspot":       "http-api-key",
  "kommo":         "http-api-key",
  "pipedrive":     "http-api-key",
  // Universal HTTP — supersedes the retired webhook-json / plain-url /
  // crm-generic apps. The server's httpRequestAdapter reads its config
  // from `templateConfig` directly.
  "http-request":  "http-request",
} as const satisfies Record<string, "telegram" | "google-sheets" | "http-api-key" | "http-request">;

export type SupportedAppKey = keyof typeof APP_KEY_TO_TEMPLATE_TYPE;

export function isSupportedAppKey(key: string): key is SupportedAppKey {
  return Object.prototype.hasOwnProperty.call(APP_KEY_TO_TEMPLATE_TYPE, key);
}

// ─── Payload shape ───────────────────────────────────────────────────────────

/**
 * Typed union describing what `destinations.create` accepts per app key.
 * The discriminator is `appKey` — the server's resolveDispatchType()
 * derives the storage-side dispatch type from it (Phase 2 of templateType
 * removal). Kept narrow so the call site gets compile-time help when the
 * server contract changes.
 */
export type CreatePayload =
  | {
      name: string;
      appKey: "telegram";
      connectionId?: number;
      chatId?: string;
      messageTemplate?: string;
    }
  | {
      name: string;
      appKey: "google-sheets";
      connectionId?: number;
      googleAccountId?: number;
      spreadsheetId: string;
      sheetName: string;
      sheetHeaders?: string[];
      mapping?: Record<string, string>;
    }
  | {
      /** Generic handler for all manifest-driven http-api-key apps —
       *  appKey is the specific app (e.g. "bitrix24", "webhook-json"). */
      name: string;
      appKey: string;
      connectionId?: number;
      templateConfig: Record<string, unknown>;
    };

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Convert dynamic-form values into a `destinations.create` payload.
 * Throws with a user-facing message when a required field is missing or a
 * complex field (e.g. headers JSON) fails to parse.
 */
export function buildCreatePayload(
  appKey: string,
  name: string,
  v: FieldValues,
): CreatePayload {
  if (appKey === "telegram") {
    const connectionId = asNumber(v.connectionId);
    if (!connectionId) {
      throw new Error("Select a Telegram connection first.");
    }
    const chatId = asString(v.chatId).trim();
    const messageTemplate = asString(v.messageTemplate);
    return {
      name,
      appKey: "telegram",
      connectionId,
      ...(chatId ? { chatId } : {}),
      ...(messageTemplate ? { messageTemplate } : {}),
    };
  }

  if (appKey === "google-sheets") {
    const connectionId = asNumber(v.connectionId);
    if (!connectionId) {
      throw new Error("Select a Google account first.");
    }
    const spreadsheetId = asString(v.spreadsheetId).trim();
    const sheetName = asString(v.sheetName).trim();
    if (!spreadsheetId) throw new Error("Spreadsheet is required.");
    if (!sheetName) throw new Error("Sheet tab is required.");
    const mapping =
      v.mapping && typeof v.mapping === "object"
        ? (v.mapping as Record<string, string>)
        : {};
    return {
      name,
      appKey: "google-sheets",
      connectionId,
      spreadsheetId,
      sheetName,
      mapping,
      sheetHeaders: Object.keys(mapping),
    };
  }

  // Generic http-api-key handler — works for any manifest app with that type.
  // The appKey IS the discriminator (server's resolveDispatchType maps the
  // specific app key into the http-api-key dispatch branch). connectionId is
  // extracted and sent top-level; all other field values go into
  // templateConfig so the server's httpApiKeyAdapter can read them.
  if (APP_KEY_TO_TEMPLATE_TYPE[appKey as SupportedAppKey] === "http-api-key") {
    const connectionId = asNumber(v.connectionId);
    const templateConfig: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "connectionId") continue;
      if (val !== undefined && val !== null && val !== "") {
        templateConfig[k] = val;
      }
    }
    return { name, appKey, connectionId, templateConfig };
  }

  // Universal HTTP request — same templateConfig pattern as http-api-key,
  // but routes to `httpRequestAdapter` server-side. There's no connection
  // (auth lives inline inside the `authentication` group), so we never set
  // connectionId here.
  if (appKey === "http-request") {
    const templateConfig: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined && val !== null && val !== "") {
        templateConfig[k] = val;
      }
    }
    return { name, appKey, templateConfig };
  }

  throw new Error(`Unsupported app: ${appKey}`);
}

// ─── Coercion helpers ────────────────────────────────────────────────────────

export function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/**
 * Collect an array of `{ name, value }` rows (the RepeatableField output)
 * into a flat Record. Blank rows are dropped silently — they're the empty
 * template the form seeds on "+ Add header" and users often leave one
 * unfilled at the bottom. Throws only when a row has a value but no name,
 * which always indicates a bug the user needs to fix.
 */
export function collectHeadersArray(
  rows: Array<Record<string, unknown>>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = asString(row?.name).trim();
    const value = asString(row?.value);
    if (!name && !value) continue; // blank row — ignore
    if (!name) {
      throw new Error(
        `Header value "${value.slice(0, 40)}" is missing a name.`,
      );
    }
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Collect the body-fields RepeatableField output into the exact shape
 * affiliateService.buildCustomBody expects — an array of `{ key, value }`.
 * Blank rows drop silently (the seed row left at the bottom of the builder
 * should never fail a save). A row with a value but no key is a bug the
 * user must fix, so we throw with a pointed message.
 */
export function collectBodyFieldsArray(
  rows: Array<Record<string, unknown>>,
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const row of rows) {
    const key = asString(row?.key).trim();
    const value = asString(row?.value);
    if (!key && !value) continue;
    if (!key) {
      throw new Error(`Body field value "${value.slice(0, 40)}" is missing a name.`);
    }
    out.push({ key, value });
  }
  return out;
}

/**
 * Append RepeatableField-shaped `{ name, value }` rows to the URL as query
 * parameters. Preserves any existing query already typed into `rawUrl` and
 * keeps user-supplied ordering. Rows with a missing name throw the same
 * error pattern as headers/body-fields so the user gets one consistent
 * failure mode across the three row builders.
 */
export function appendQueryParams(
  rawUrl: string,
  rows: Array<Record<string, unknown>>,
): string {
  const clean: Array<[string, string]> = [];
  for (const row of rows) {
    const name = asString(row?.name).trim();
    const value = asString(row?.value);
    if (!name && !value) continue;
    if (!name) {
      throw new Error(`Query value "${value.slice(0, 40)}" is missing a parameter name.`);
    }
    clean.push([name, value]);
  }
  if (clean.length === 0) return rawUrl;

  const qs = clean
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const sep = rawUrl.includes("?") ? "&" : "?";
  return `${rawUrl}${sep}${qs}`;
}

export function parseHeadersJson(
  raw: string,
): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "parse error";
    throw new Error(`Invalid headers JSON: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid headers JSON: expected a JSON object.");
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new Error(`Invalid headers JSON: header "${k}" must be a string.`);
    }
    out[k] = val;
  }
  return out;
}

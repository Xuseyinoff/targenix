/**
 * createPayload — pure helpers that translate `DynamicForm` values into the
 * shape expected by the `targetWebsites.create` tRPC mutation.
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
 * Manifest `app.key` → `targetWebsites.create` templateType. Apps not in
 * this map are rejected by `buildCreatePayload`.
 */
export const APP_KEY_TO_TEMPLATE_TYPE = {
  telegram: "telegram",
  "google-sheets": "google-sheets",
  "plain-url": "custom",
} as const satisfies Record<string, "telegram" | "google-sheets" | "custom">;

export type SupportedAppKey = keyof typeof APP_KEY_TO_TEMPLATE_TYPE;

export function isSupportedAppKey(key: string): key is SupportedAppKey {
  return Object.prototype.hasOwnProperty.call(APP_KEY_TO_TEMPLATE_TYPE, key);
}

// ─── Payload shape ───────────────────────────────────────────────────────────

/**
 * Typed union describing what `targetWebsites.create` accepts per template
 * type. Kept narrow so the call site gets compile-time help when the server
 * contract changes.
 */
export type CreatePayload =
  | {
      name: string;
      templateType: "telegram";
      connectionId?: number;
      chatId?: string;
      messageTemplate?: string;
    }
  | {
      name: string;
      templateType: "google-sheets";
      connectionId?: number;
      googleAccountId?: number;
      spreadsheetId: string;
      sheetName: string;
      sheetHeaders?: string[];
      mapping?: Record<string, string>;
    }
  | {
      name: string;
      templateType: "custom";
      url: string;
      method?: "POST" | "GET";
      contentType?: "json" | "form" | "form-urlencoded" | "multipart";
      bodyTemplate?: string;
      headers?: Record<string, string>;
    };

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Convert dynamic-form values into a `targetWebsites.create` payload.
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
      templateType: "telegram",
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
      templateType: "google-sheets",
      connectionId,
      spreadsheetId,
      sheetName,
      mapping,
      sheetHeaders: Object.keys(mapping),
    };
  }

  if (appKey === "plain-url") {
    const url = asString(v.url).trim();
    if (!url) throw new Error("URL is required.");
    const method = asString(v.method) === "GET" ? "GET" : "POST";
    const contentTypeRaw = asString(v.contentType);
    const contentType: "json" | "form-urlencoded" | "multipart" =
      contentTypeRaw === "form-urlencoded" || contentTypeRaw === "multipart"
        ? (contentTypeRaw as "form-urlencoded" | "multipart")
        : "json";
    const bodyTemplate = asString(v.bodyTemplate);
    // Headers switched from a JSON-blob `code` field to a Make.com-style
    // "+ Add header" row builder (type: "repeatable"). To keep the server
    // contract identical we accept BOTH shapes:
    //   • Array<{ name, value }>  (new row-builder output)
    //   • string (legacy raw JSON) (persisted templates, unit tests)
    // and always emit Record<string, string> to targetWebsites.create.
    const headers = Array.isArray(v.headers)
      ? collectHeadersArray(v.headers as Array<Record<string, unknown>>)
      : parseHeadersJson(asString(v.headers));
    return {
      name,
      templateType: "custom",
      url,
      method,
      contentType,
      ...(bodyTemplate ? { bodyTemplate } : {}),
      ...(headers ? { headers } : {}),
    };
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

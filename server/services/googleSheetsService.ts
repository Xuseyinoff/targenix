/**
 * Append one row to a Google Sheet using an integration OAuth account.
 * Uses Sheets v4 values.append (RAW) — same token path as future Drive/Sheets features.
 */

import { and, eq } from "drizzle-orm";
import { googleAccounts } from "../../drizzle/schema";
import { getDb } from "../db";
import { getValidGoogleAccessToken } from "../routes/googleOAuth";
import {
  GOOGLE_SHEETS_MAPPABLE_FIELDS,
  type GoogleSheetsMappableField,
} from "../../shared/googleSheets";
import { inferDeliveryErrorType, type DeliveryErrorType } from "../lib/orderRetryPolicy";

/** Re-export for callers that import from service. */
export { GOOGLE_SHEETS_MAPPABLE_FIELDS, type GoogleSheetsMappableField };

/** A1 range for append (wide columns). */
function sheetAppendRange(sheetName: string): string {
  const escaped = sheetName.replace(/'/g, "''");
  return `'${escaped}'!A:Z`;
}

/** First row (header labels) — GET values. */
function sheetHeaderRowRange(sheetName: string): string {
  const escaped = sheetName.replace(/'/g, "''");
  return `'${escaped}'!1:1`;
}

export type GoogleSheetsLeadPayload = {
  leadgenId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  pageId: string;
  formId: string;
  extraFields?: Record<string, string>;
};

function parseSheetsApiError(data: unknown, text: string, status: number): string {
  let msg = `HTTP ${status}`;
  if (typeof data === "object" && data !== null && "error" in data) {
    const errObj = (data as { error?: { message?: string } }).error;
    if (errObj?.message) msg = errObj.message;
    else msg = JSON.stringify((data as { error: unknown }).error);
  } else if (text.length > 0) {
    msg = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
  return msg;
}

/**
 * Google returns `Unable to parse range: 'X'!...` when the referenced tab
 * title doesn't exist. We detect that case so the caller can decorate the
 * error with the spreadsheet's actual tab titles — a much more useful
 * diagnostic than the raw API string.
 */
function isSheetNotFoundError(msg: string): boolean {
  return typeof msg === "string" && /unable to parse range/i.test(msg);
}

/**
 * Fetches tab titles straight from the Sheets API using a pre-resolved
 * access token. Used as a post-error diagnostic — never throws; on failure
 * returns null so the caller can emit the original error unchanged.
 */
async function fetchTabTitlesWithToken(
  accessToken: string,
  spreadsheetId: string,
): Promise<string[] | null> {
  try {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
    );
    url.searchParams.set("fields", "sheets.properties.title");
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      sheets?: Array<{ properties?: { title?: string } }>;
    };
    const titles = (data.sheets ?? [])
      .map((s) => (typeof s.properties?.title === "string" ? s.properties.title : ""))
      .filter((t) => t.length > 0);
    return titles;
  } catch {
    return null;
  }
}

/**
 * Build a user-friendly "tab not found" message listing the spreadsheet's
 * actual tab titles. Falls back to the raw API error when the diagnostic
 * probe itself fails.
 */
function formatSheetNotFoundError(
  attemptedSheetName: string,
  availableTitles: string[] | null,
  fallback: string,
): string {
  if (!availableTitles || availableTitles.length === 0) {
    return `Sheet tab "${attemptedSheetName}" not found in this spreadsheet. ${fallback}`;
  }
  const preview = availableTitles.slice(0, 10).map((t) => `"${t}"`).join(", ");
  const suffix = availableTitles.length > 10 ? ` (+${availableTitles.length - 10} more)` : "";
  return `Sheet tab "${attemptedSheetName}" not found. Available tabs in this spreadsheet: ${preview}${suffix}. Open the destination and pick one of the available tabs, or rename your sheet to match.`;
}

/** In-memory cache for Drive/Sheets browse helpers (per-user, short TTL). */
const BROWSE_CACHE_MS = 5 * 60 * 1000;
const spreadsheetsListCache = new Map<string, { at: number; data: { id: string; name: string }[] }>();
const spreadsheetTabsCache = new Map<string, { at: number; data: string[] }>();

function browseCacheGet<T>(m: Map<string, { at: number; data: T }>, key: string): T | undefined {
  const row = m.get(key);
  if (!row || Date.now() - row.at > BROWSE_CACHE_MS) return undefined;
  return row.data;
}

function browseCacheSet<T>(m: Map<string, { at: number; data: T }>, key: string, data: T) {
  m.set(key, { at: Date.now(), data });
}

async function resolveIntegrationGoogleAccessToken(
  userId: number,
  googleAccountId: number,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  if (!Number.isFinite(googleAccountId) || googleAccountId < 1) {
    return { ok: false, error: "Missing or invalid googleAccountId" };
  }

  const db = await getDb();
  if (!db) return { ok: false, error: "Database not available" };

  const [row] = await db
    .select({ id: googleAccounts.id })
    .from(googleAccounts)
    .where(
      and(
        eq(googleAccounts.id, googleAccountId),
        eq(googleAccounts.userId, userId),
        eq(googleAccounts.type, "integration"),
      ),
    )
    .limit(1);

  if (!row) {
    return { ok: false, error: "Google integration account not found" };
  }

  try {
    const accessToken = await getValidGoogleAccessToken(googleAccountId);
    return { ok: true, accessToken };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * List spreadsheets visible to the integration account (Drive API).
 * Requires `drive.metadata.readonly` on the OAuth token (reconnect if 403).
 */
export async function listUserSpreadsheets(params: {
  userId: number;
  googleAccountId: number;
  /** Optional filter: `name contains` (case-insensitive per Drive behavior). */
  nameContains?: string;
}): Promise<{ success: boolean; data?: { id: string; name: string }[]; error?: string }> {
  const { userId, googleAccountId } = params;
  const rawQ = (params.nameContains ?? "").trim().slice(0, 120);
  const cacheKey = `${userId}:${googleAccountId}:${rawQ || "__all__"}`;
  const hit = browseCacheGet(spreadsheetsListCache, cacheKey);
  if (hit) return { success: true, data: hit };

  const resolved = await resolveIntegrationGoogleAccessToken(userId, googleAccountId);
  if (!resolved.ok) return { success: false, error: resolved.error };

  let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
  if (rawQ.length > 0) {
    q += ` and name contains '${escapeDriveQueryLiteral(rawQ)}'`;
  }

  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name),nextPageToken");
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${resolved.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const errMsg = parseSheetsApiError(data, text, res.status);
      const hint =
        res.status === 403
          ? `${errMsg} If you connected Google before this update, disconnect and reconnect to grant Drive list access.`
          : errMsg;
      return { success: false, error: hint };
    }

    const files = (data as { files?: Array<{ id?: string; name?: string }> }).files ?? [];
    const list = files
      .filter((f) => typeof f.id === "string" && f.id.length > 0)
      .map((f) => ({ id: f.id as string, name: typeof f.name === "string" ? f.name : "(untitled)" }));

    browseCacheSet(spreadsheetsListCache, cacheKey, list);
    return { success: true, data: list };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Tab titles for a spreadsheet (Sheets API spreadsheets.get).
 */
export async function getSpreadsheetSheetTitles(params: {
  userId: number;
  googleAccountId: number;
  spreadsheetId: string;
}): Promise<{ success: boolean; data?: string[]; error?: string }> {
  const { userId, googleAccountId, spreadsheetId } = params;
  if (typeof spreadsheetId !== "string" || !spreadsheetId.trim()) {
    return { success: false, error: "Missing spreadsheetId" };
  }

  const sid = spreadsheetId.trim();
  const cacheKey = `${userId}:${googleAccountId}:${sid}`;
  const hit = browseCacheGet(spreadsheetTabsCache, cacheKey);
  if (hit) return { success: true, data: hit };

  const resolved = await resolveIntegrationGoogleAccessToken(userId, googleAccountId);
  if (!resolved.ok) return { success: false, error: resolved.error };

  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}`,
  );
  url.searchParams.set("fields", "sheets.properties.title");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${resolved.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      return { success: false, error: parseSheetsApiError(data, text, res.status) };
    }

    const sheets = (data as { sheets?: Array<{ properties?: { title?: string } }> }).sheets ?? [];
    const titles = sheets
      .map((s) => (typeof s.properties?.title === "string" ? s.properties.title : ""))
      .filter((t) => t.length > 0);

    browseCacheSet(spreadsheetTabsCache, cacheKey, titles);
    return { success: true, data: titles };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read row 1 of a tab as header labels (GET .../values/{sheet}!1:1).
 */
export async function getGoogleSheetHeaders(params: {
  userId: number;
  googleAccountId: number;
  spreadsheetId: string;
  sheetName: string;
}): Promise<{ success: boolean; headers?: string[]; error?: string }> {
  const { userId, googleAccountId, spreadsheetId, sheetName } = params;

  if (!Number.isFinite(googleAccountId) || googleAccountId < 1) {
    return { success: false, error: "Missing or invalid googleAccountId" };
  }
  if (typeof spreadsheetId !== "string" || !spreadsheetId.trim()) {
    return { success: false, error: "Missing spreadsheetId" };
  }
  if (typeof sheetName !== "string" || !sheetName.trim()) {
    return { success: false, error: "Missing sheetName" };
  }

  const resolved = await resolveIntegrationGoogleAccessToken(userId, googleAccountId);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const accessToken = resolved.accessToken;

  const range = sheetHeaderRowRange(sheetName.trim());
  const encodedRange = encodeURIComponent(range);
  const sid = spreadsheetId.trim();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodedRange}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const rawMsg = parseSheetsApiError(data, text, res.status);
      if (isSheetNotFoundError(rawMsg)) {
        const titles = await fetchTabTitlesWithToken(accessToken, sid);
        return { success: false, error: formatSheetNotFoundError(sheetName.trim(), titles, rawMsg) };
      }
      return { success: false, error: rawMsg };
    }

    const values = (data as { values?: string[][] }).values;
    const firstRow = Array.isArray(values) && values.length > 0 && Array.isArray(values[0]) ? values[0] : [];
    const headers = firstRow.map((c) => (c == null ? "" : String(c)));
    return { success: true, headers };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const DEFAULT_COLUMN_ORDER: readonly GoogleSheetsMappableField[] = [
  "fullName",
  "phone",
  "email",
  "createdAt",
];

export function resolveGoogleSheetCellValue(
  fieldKey: string,
  ctx: { leadPayload: GoogleSheetsLeadPayload; createdAtIso: string },
): string {
  if (!fieldKey || fieldKey === "__none__") return "";
  const { leadPayload, createdAtIso } = ctx;
  switch (fieldKey) {
    case "fullName":
      return leadPayload.fullName ?? "";
    case "phone":
      return leadPayload.phone ?? "";
    case "email":
      return leadPayload.email ?? "";
    case "createdAt":
      return createdAtIso;
    case "leadgenId":
      return leadPayload.leadgenId ?? "";
    case "pageId":
      return leadPayload.pageId ?? "";
    case "formId":
      return leadPayload.formId ?? "";
    default:
      return leadPayload.extraFields?.[fieldKey] ?? "";
  }
}

/**
 * Build one append row. If `sheetHeaders` is stored, length matches columns.
 * If `mapping` is missing or has no usable entries → default column order by index (backward compatible).
 */
export function buildGoogleSheetsAppendRow(params: {
  sheetHeaders?: string[] | null;
  mapping?: Record<string, string> | null;
  leadPayload: GoogleSheetsLeadPayload;
  createdAtIso: string;
}): string[] {
  const { sheetHeaders, mapping, leadPayload, createdAtIso } = params;
  const ctx = { leadPayload, createdAtIso };
  const headers = Array.isArray(sheetHeaders) && sheetHeaders.length > 0 ? sheetHeaders : null;
  const mapObj = mapping && typeof mapping === "object" ? mapping : null;
  const mappingHasEntry =
    !!mapObj &&
    Object.keys(mapObj).some((k) => {
      const v = mapObj[k];
      return typeof v === "string" && v.length > 0 && v !== "__none__";
    });

  if (headers) {
    return headers.map((col, index) => {
      if (mappingHasEntry) {
        const fk = mapObj![col] ?? "";
        if (!fk || fk === "__none__") return "";
        return resolveGoogleSheetCellValue(fk, ctx);
      }
      const fk = DEFAULT_COLUMN_ORDER[index] ?? "";
      return resolveGoogleSheetCellValue(fk, ctx);
    });
  }

  return [
    resolveGoogleSheetCellValue("fullName", ctx),
    resolveGoogleSheetCellValue("phone", ctx),
    resolveGoogleSheetCellValue("email", ctx),
    resolveGoogleSheetCellValue("createdAt", ctx),
  ];
}

export async function appendLeadToGoogleSheet(params: {
  /** Owner of the destination — must match google_accounts.userId */
  userId: number;
  googleAccountId: number;
  spreadsheetId: string;
  sheetName: string;
  /** Single row of cell values */
  values: string[];
}): Promise<{ success: boolean; error?: string; errorType?: DeliveryErrorType; responseData?: unknown }> {
  const { userId, googleAccountId, spreadsheetId, sheetName, values } = params;

  if (!Number.isFinite(googleAccountId) || googleAccountId < 1) {
    return { success: false, error: "Missing or invalid googleAccountId", errorType: "validation" };
  }
  if (typeof spreadsheetId !== "string" || !spreadsheetId.trim()) {
    return { success: false, error: "Missing spreadsheetId", errorType: "validation" };
  }
  if (typeof sheetName !== "string" || !sheetName.trim()) {
    return { success: false, error: "Missing sheetName", errorType: "validation" };
  }
  if (!Array.isArray(values)) {
    return { success: false, error: "Missing values", errorType: "validation" };
  }

  const db = await getDb();
  if (!db) {
    return { success: false, error: "Database not available" };
  }

  const [acct] = await db
    .select({ id: googleAccounts.id })
    .from(googleAccounts)
    .where(
      and(
        eq(googleAccounts.id, googleAccountId),
        eq(googleAccounts.userId, userId),
        eq(googleAccounts.type, "integration"),
      ),
    )
    .limit(1);

  if (!acct) {
    return { success: false, error: "Google integration account not found", errorType: "validation" };
  }

  let accessToken: string;
  try {
    accessToken = await getValidGoogleAccessToken(googleAccountId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg,
      errorType: inferDeliveryErrorType({ message: msg }) ?? "auth",
    };
  }

  const range = sheetAppendRange(sheetName.trim());
  const encodedRange = encodeURIComponent(range);
  const sid = spreadsheetId.trim();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodedRange}:append?valueInputOption=RAW`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [values] }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      let errMsg = parseSheetsApiError(data, text, res.status);
      if (isSheetNotFoundError(errMsg)) {
        const titles = await fetchTabTitlesWithToken(accessToken, sid);
        errMsg = formatSheetNotFoundError(sheetName.trim(), titles, errMsg);
        // Tab-mismatch is a user-config problem, not a transient failure.
        // Mark it as `validation` so the retry scheduler does NOT keep
        // hammering the API — the user needs to fix the destination first.
        return { success: false, error: errMsg, errorType: "validation" };
      }
      return {
        success: false,
        error: errMsg,
        errorType: inferDeliveryErrorType({ httpStatus: res.status, message: errMsg }),
      };
    }

    return { success: true, responseData: data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg,
      errorType: inferDeliveryErrorType({ message: msg }) ?? "network",
    };
  }
}

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

  const db = await getDb();
  if (!db) return { success: false, error: "Database not available" };

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
    return { success: false, error: "Google integration account not found" };
  }

  let accessToken: string;
  try {
    accessToken = await getValidGoogleAccessToken(googleAccountId);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

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
      return { success: false, error: parseSheetsApiError(data, text, res.status) };
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
      const errMsg = parseSheetsApiError(data, text, res.status);
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

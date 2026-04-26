/**
 * Google Sheets dynamic option loaders.
 *
 *   google-sheets.listSpreadsheets  → spreadsheet picker (supports search + pagination)
 *   google-sheets.listSheetTabs     → tab picker (depends on spreadsheetId)
 *   google-sheets.getSheetHeaders   → column headers for field-mapping
 *
 * All loaders use the shared loaderCache (TTL 60 s for tabs/headers,
 * 30 s for spreadsheet list so search results stay fresh).
 *
 * Error codes:
 *   CONNECTION_REQUIRED   — connectionId missing
 *   CONNECTION_INVALID    — row not found, wrong type, inactive, bad token
 *   MISSING_PARAM         — required dependsOn field absent
 *   EXTERNAL_API_ERROR    — Google API returned an error
 */

import { and, eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import {
  getGoogleSheetHeaders,
  getSpreadsheetSheetTitles,
  listUserSpreadsheets,
} from "../../services/googleSheetsService";
import { registerLoader } from "./registry";
import { loaderCache } from "./cache";
import {
  LoaderValidationError,
  type LoadOptionsContext,
  type LoadOptionsResult,
} from "./types";

// ─── Connection resolution ────────────────────────────────────────────────────

async function resolveGoogleAccountId(ctx: LoadOptionsContext): Promise<number> {
  if (ctx.connectionId == null) {
    throw LoaderValidationError.connectionRequired(
      "Select a Google account connection first.",
    );
  }
  const [row] = await ctx.db
    .select()
    .from(connections)
    .where(
      and(eq(connections.id, ctx.connectionId), eq(connections.userId, ctx.userId)),
    )
    .limit(1);

  if (!row) {
    throw LoaderValidationError.connectionInvalid(
      "Connection not found or does not belong to you.",
    );
  }
  if (row.type !== "google_sheets") {
    throw LoaderValidationError.connectionInvalid(
      `Connection type is '${row.type}' — expected 'google_sheets'.`,
    );
  }
  if (row.status !== "active") {
    throw LoaderValidationError.connectionInvalid(
      `Connection is '${row.status}'. Reconnect it before continuing.`,
    );
  }
  const gid = row.oauthTokenId;
  if (typeof gid !== "number" || !Number.isFinite(gid) || gid < 1) {
    throw LoaderValidationError.connectionInvalid(
      "Connection is missing a Google OAuth link — reconnect it.",
    );
  }
  return gid;
}

function requireStringParam(ctx: LoadOptionsContext, key: string): string {
  const raw = ctx.params[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw LoaderValidationError.missingParam(key);
  }
  return raw.trim();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

/**
 * List all Google Spreadsheets the user has access to.
 * Supports search (name filter) and basic offset pagination via cursor = page index.
 */
async function listSpreadsheets(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const CACHE_TTL = 30; // seconds — short so search results stay fresh

  const cached = loaderCache.get(
    ctx.userId, "google-sheets.listSpreadsheets",
    ctx.connectionId, ctx.params,
    ctx.search, ctx.cursor, ctx.limit,
  );
  if (cached) return cached;

  const googleAccountId = await resolveGoogleAccountId(ctx);
  const nameContains = ctx.search?.trim() || undefined;

  const res = await listUserSpreadsheets({
    userId: ctx.userId,
    googleAccountId,
    nameContains,
  });
  if (!res.success) {
    throw LoaderValidationError.externalApiError(res.error ?? "Failed to list spreadsheets.");
  }

  const allRows = res.data ?? [];

  // Simple offset pagination using cursor = numeric page index (0-based).
  const page = ctx.cursor ? Math.max(0, parseInt(ctx.cursor, 10) || 0) : 0;
  const pageSize = ctx.limit;
  const start = page * pageSize;
  const slice = allRows.slice(start, start + pageSize);
  const hasMore = start + pageSize < allRows.length;

  const result: LoadOptionsResult = {
    options: slice.map((r) => ({ value: r.id, label: r.name })),
    hasMore,
    nextCursor: hasMore ? String(page + 1) : undefined,
  };

  loaderCache.set(
    ctx.userId, "google-sheets.listSpreadsheets",
    ctx.connectionId, ctx.params,
    ctx.search, ctx.cursor, ctx.limit,
    result,
    { ttlSeconds: CACHE_TTL },
  );

  return result;
}

/** List sheet tabs for a given spreadsheet. */
async function listSheetTabs(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const CACHE_TTL = 60;

  const cached = loaderCache.get(
    ctx.userId, "google-sheets.listSheetTabs",
    ctx.connectionId, ctx.params,
    ctx.search, ctx.cursor, ctx.limit,
  );
  if (cached) return cached;

  const googleAccountId = await resolveGoogleAccountId(ctx);
  const spreadsheetId = requireStringParam(ctx, "spreadsheetId");

  const res = await getSpreadsheetSheetTitles({
    userId: ctx.userId,
    googleAccountId,
    spreadsheetId,
  });
  if (!res.success) {
    throw LoaderValidationError.externalApiError(res.error ?? "Failed to list sheet tabs.");
  }

  const titles = res.data ?? [];
  const filtered = ctx.search
    ? titles.filter((t) => t.toLowerCase().includes(ctx.search!.toLowerCase()))
    : titles;

  const result: LoadOptionsResult = {
    options: filtered.map((t) => ({ value: t, label: t })),
  };

  loaderCache.set(
    ctx.userId, "google-sheets.listSheetTabs",
    ctx.connectionId, ctx.params,
    ctx.search, ctx.cursor, ctx.limit,
    result,
    { ttlSeconds: CACHE_TTL },
  );

  return result;
}

/** Read row-1 headers from a specific sheet tab. No caching (headers change frequently). */
async function getHeaders(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const googleAccountId = await resolveGoogleAccountId(ctx);
  const spreadsheetId = requireStringParam(ctx, "spreadsheetId");
  const sheetName = requireStringParam(ctx, "sheetName");

  const res = await getGoogleSheetHeaders({
    userId: ctx.userId,
    googleAccountId,
    spreadsheetId,
    sheetName,
  });
  if (!res.success) {
    throw LoaderValidationError.externalApiError(res.error ?? "Failed to read sheet headers.");
  }

  const headers = res.headers ?? [];
  return {
    options: headers.map((h, idx) => ({
      value: h,
      label: h,
      meta: { columnIndex: idx },
    })),
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerGoogleSheetsLoaders(): void {
  registerLoader("google-sheets.listSpreadsheets", listSpreadsheets);
  registerLoader("google-sheets.listSheetTabs", listSheetTabs);
  registerLoader("google-sheets.getSheetHeaders", getHeaders);
}

export const __testing = {
  listSpreadsheets,
  listSheetTabs,
  getHeaders,
  resolveGoogleAccountId,
};

/**
 * Google Sheets dynamic option loaders (Commit 2 of Phase 4).
 *
 * Each loader is the runtime counterpart of one key declared in
 * googleSheetsApp.dynamicOptionsLoaders:
 *   google-sheets.listSpreadsheets  → spreadsheet picker
 *   google-sheets.listSheetTabs     → tab picker (depends on spreadsheetId)
 *   google-sheets.getSheetHeaders   → column headers for field-mapping
 *
 * Connection resolution:
 *   All three loaders receive `connectionId` from the form state. We look up
 *   the connections row, verify ownership + type + active status, and pull
 *   out `oauthTokenId` (as googleAccountId in the service) for googleSheetsService
 *   helpers. Any failure is surfaced as a LoaderValidationError so the client
 *   can prompt the user to fix their connection.
 */

import { and, eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import {
  getGoogleSheetHeaders,
  getSpreadsheetSheetTitles,
  listUserSpreadsheets,
} from "../../services/googleSheetsService";
import { registerLoader } from "./registry";
import {
  LoaderValidationError,
  type LoadOptionsContext,
  type LoadOptionsResult,
} from "./types";

async function resolveGoogleAccountId(ctx: LoadOptionsContext): Promise<number> {
  if (ctx.connectionId == null) {
    throw new LoaderValidationError(
      "Google account is required — select a connection first.",
    );
  }
  const [row] = await ctx.db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, ctx.connectionId),
        eq(connections.userId, ctx.userId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new LoaderValidationError(
      "Connection not found or does not belong to you.",
    );
  }
  if (row.type !== "google_sheets") {
    throw new LoaderValidationError(
      `Connection type is '${row.type}' — expected 'google_sheets'.`,
    );
  }
  if (row.status !== "active") {
    throw new LoaderValidationError(
      `Connection is '${row.status}'. Reconnect it before continuing.`,
    );
  }
  const gid = row.oauthTokenId;
  if (typeof gid !== "number" || !Number.isFinite(gid) || gid < 1) {
    throw new LoaderValidationError(
      "Connection is missing a Google OAuth link — reconnect it.",
    );
  }
  return gid;
}

function requireStringParam(
  ctx: LoadOptionsContext,
  key: string,
  label: string,
): string {
  const raw = ctx.params[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new LoaderValidationError(`${label} is required.`);
  }
  return raw.trim();
}

async function listSpreadsheets(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const googleAccountId = await resolveGoogleAccountId(ctx);
  const searchRaw = ctx.params.search;
  const nameContains =
    typeof searchRaw === "string" && searchRaw.trim() ? searchRaw.trim() : undefined;

  const res = await listUserSpreadsheets({
    userId: ctx.userId,
    googleAccountId,
    nameContains,
  });
  if (!res.success) {
    throw new LoaderValidationError(res.error ?? "Failed to list spreadsheets.");
  }
  const rows = res.data ?? [];
  return {
    options: rows.map((r) => ({ value: r.id, label: r.name })),
  };
}

async function listSheetTabs(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const googleAccountId = await resolveGoogleAccountId(ctx);
  const spreadsheetId = requireStringParam(ctx, "spreadsheetId", "Spreadsheet");

  const res = await getSpreadsheetSheetTitles({
    userId: ctx.userId,
    googleAccountId,
    spreadsheetId,
  });
  if (!res.success) {
    throw new LoaderValidationError(res.error ?? "Failed to list sheet tabs.");
  }
  const titles = res.data ?? [];
  return {
    options: titles.map((t) => ({ value: t, label: t })),
  };
}

async function getHeaders(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const googleAccountId = await resolveGoogleAccountId(ctx);
  const spreadsheetId = requireStringParam(ctx, "spreadsheetId", "Spreadsheet");
  const sheetName = requireStringParam(ctx, "sheetName", "Sheet");

  const res = await getGoogleSheetHeaders({
    userId: ctx.userId,
    googleAccountId,
    spreadsheetId,
    sheetName,
  });
  if (!res.success) {
    throw new LoaderValidationError(res.error ?? "Failed to read sheet headers.");
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

export function registerGoogleSheetsLoaders(): void {
  registerLoader("google-sheets.listSpreadsheets", listSpreadsheets);
  registerLoader("google-sheets.listSheetTabs", listSheetTabs);
  registerLoader("google-sheets.getSheetHeaders", getHeaders);
}

// Test-only exports — individual loaders for targeted unit tests.
export const __testing = {
  listSpreadsheets,
  listSheetTabs,
  getHeaders,
  resolveGoogleAccountId,
};

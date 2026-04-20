import { eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import {
  appendLeadToGoogleSheet,
  buildGoogleSheetsAppendRow,
} from "../../services/googleSheetsService";
import type { LeadPayload } from "../../services/affiliateService";
import type { DbClient } from "../../db";
import type { DeliveryResult } from "../types";

interface GoogleSheetsLeadRow {
  createdAt?: Date | null;
}

interface GoogleSheetsAdapterConfig {
  templateConfig: unknown;
  userId: number;
  leadRow: GoogleSheetsLeadRow;
  /** Step 3 hybrid mode — when provided, googleAccountId is resolved from connections first. */
  db?: DbClient;
  connectionId?: number | null;
}

/**
 * Try the unified connections table first. On any failure (missing row, owner
 * mismatch, wrong type, inactive status, missing googleAccountId, DB error)
 * return null so the caller can fall back to templateConfig.googleAccountId.
 *
 * Never throws — delivery must remain robust while Step 3 rolls out.
 */
async function tryResolveGoogleAccountIdFromConnection(
  db: DbClient | undefined,
  userId: number,
  connectionId: number | null | undefined,
): Promise<number | null> {
  if (!db || !connectionId) return null;

  try {
    const [row] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    if (!row) return null;
    if (row.userId !== userId) {
      console.warn(
        `[googleSheetsAdapter] connection ${connectionId} owner mismatch (userId=${row.userId}, expected=${userId}); falling back`,
      );
      return null;
    }
    if (row.type !== "google_sheets") {
      console.warn(
        `[googleSheetsAdapter] connection ${connectionId} type='${row.type}' (expected 'google_sheets'); falling back`,
      );
      return null;
    }
    if (row.status !== "active") {
      console.warn(
        `[googleSheetsAdapter] connection ${connectionId} status='${row.status}' (expected 'active'); falling back`,
      );
      return null;
    }

    const gid = row.googleAccountId;
    if (typeof gid !== "number" || !Number.isFinite(gid) || gid < 1) return null;
    return gid;
  } catch (err) {
    console.warn(
      `[googleSheetsAdapter] connection ${connectionId} load failed; falling back to templateConfig:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export const googleSheetsAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const opts = config as GoogleSheetsAdapterConfig;
    const { templateConfig, userId, leadRow } = opts;
    const cfg = (templateConfig ?? {}) as Record<string, unknown>;

    const fromConn = await tryResolveGoogleAccountIdFromConnection(
      opts.db,
      userId,
      opts.connectionId,
    );

    let googleAccountId: number;
    if (fromConn != null) {
      googleAccountId = fromConn;
    } else {
      const gidRaw = cfg.googleAccountId;
      const parsed =
        typeof gidRaw === "number" && Number.isFinite(gidRaw)
          ? gidRaw
          : typeof gidRaw === "string"
            ? parseInt(String(gidRaw).trim(), 10)
            : NaN;
      googleAccountId = parsed;
    }

    const spreadsheetId = typeof cfg.spreadsheetId === "string" ? cfg.spreadsheetId.trim() : "";
    const sheetName = typeof cfg.sheetName === "string" ? cfg.sheetName.trim() : "";

    if (!Number.isFinite(googleAccountId) || googleAccountId < 1 || !spreadsheetId || !sheetName) {
      return {
        success: false,
        error: "Google Sheets destination missing googleAccountId, spreadsheetId, or sheetName",
        errorType: "validation",
      };
    }

    const ts = leadRow.createdAt
      ? new Date(leadRow.createdAt).toISOString()
      : new Date().toISOString();

    const sheetHeaders = Array.isArray(cfg.sheetHeaders)
      ? (cfg.sheetHeaders as string[])
      : null;
    const mapping =
      cfg.mapping && typeof cfg.mapping === "object" && !Array.isArray(cfg.mapping)
        ? (cfg.mapping as Record<string, string>)
        : null;

    const rowValues = buildGoogleSheetsAppendRow({
      sheetHeaders,
      mapping,
      leadPayload: {
        ...lead,
        extraFields: lead.extraFields ?? {},
      },
      createdAtIso: ts,
    });

    return appendLeadToGoogleSheet({
      userId,
      googleAccountId,
      spreadsheetId,
      sheetName,
      values: rowValues,
    });
  },
};

import {
  appendLeadToGoogleSheet,
  buildGoogleSheetsAppendRow,
} from "../../services/googleSheetsService";
import type { LeadPayload } from "../../services/affiliateService";
import type { DeliveryResult } from "../types";

interface GoogleSheetsLeadRow {
  createdAt?: Date | null;
}

interface GoogleSheetsAdapterConfig {
  templateConfig: unknown;
  userId: number;
  leadRow: GoogleSheetsLeadRow;
}

export const googleSheetsAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { templateConfig, userId, leadRow } = config as GoogleSheetsAdapterConfig;
    const cfg = (templateConfig ?? {}) as Record<string, unknown>;

    const gidRaw = cfg.googleAccountId;
    const googleAccountId =
      typeof gidRaw === "number" && Number.isFinite(gidRaw)
        ? gidRaw
        : typeof gidRaw === "string"
          ? parseInt(String(gidRaw).trim(), 10)
          : NaN;
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

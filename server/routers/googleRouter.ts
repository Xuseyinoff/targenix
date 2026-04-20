/**
 * Google API helpers for the dashboard (Sheets/Drive browse).
 * Separate from `googleAccounts` (connection CRUD).
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { getSpreadsheetSheetTitles, listUserSpreadsheets } from "../services/googleSheetsService";

export const googleRouter = router({
  listSpreadsheets: protectedProcedure
    .input(
      z.object({
        googleAccountId: z.number().int().positive(),
        nameContains: z.string().max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "googleListSpreadsheets", {
        max: 30,
        windowMs: 60_000,
        message: "Too many spreadsheet list requests. Max 30 per minute.",
      });
      return listUserSpreadsheets({
        userId: ctx.user.id,
        googleAccountId: input.googleAccountId,
        nameContains: input.nameContains,
      });
    }),

  listSheets: protectedProcedure
    .input(
      z.object({
        googleAccountId: z.number().int().positive(),
        spreadsheetId: z.string().min(1).max(256),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "googleListSheets", {
        max: 40,
        windowMs: 60_000,
        message: "Too many sheet tab requests. Max 40 per minute.",
      });
      return getSpreadsheetSheetTitles({
        userId: ctx.user.id,
        googleAccountId: input.googleAccountId,
        spreadsheetId: input.spreadsheetId.trim(),
      });
    }),
});

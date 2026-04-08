/**
 * adAnalyticsRouter.ts
 *
 * tRPC procedures for the Business Tools → Ad Analytics module.
 *
 * Procedures:
 *  - adAnalytics.listAdAccounts   — list all ad accounts across connected FB accounts
 *  - adAnalytics.getInsights      — fetch insights for a specific ad account (with date preset)
 *  - adAnalytics.listCampaigns    — list campaigns for a specific ad account
 *  - adAnalytics.getCampaignInsights — fetch campaign-level insights (CPL/CTR/CVR)
 *  - adAnalytics.checkAlerts      — compare CPL vs 7-day avg, send Telegram alert if anomaly
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { decrypt } from "../encryption";
import {
  fetchAdAccounts,
  fetchAdAccountInsights,
  type AdAccount,
  type InsightsSummary,
} from "../services/adAccountsService";
import {
  fetchCampaigns,
  fetchCampaignInsights,
} from "../services/campaignService";
import { notifyOwner } from "../_core/notification";
import { facebookAccounts } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";

// ─── Date preset validation ───────────────────────────────────────────────────
const DATE_PRESETS = ["today", "yesterday", "last_7d", "last_30d"] as const;
type DatePreset = typeof DATE_PRESETS[number];

// Map frontend presets to Facebook API date_preset values
const FB_DATE_PRESET_MAP: Record<DatePreset, string> = {
  today: "today",
  yesterday: "yesterday",
  last_7d: "last_7_days",
  last_30d: "last_30d",
};

// ─── Helper: get all decrypted tokens for a user ──────────────────────────────
async function getUserFbTokens(
  userId: number
): Promise<Array<{ id: number; fbUserId: string; fbUserName: string; accessToken: string }>> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: facebookAccounts.id,
      fbUserId: facebookAccounts.fbUserId,
      fbUserName: facebookAccounts.fbUserName,
      accessToken: facebookAccounts.accessToken,
    })
    .from(facebookAccounts)
    .where(eq(facebookAccounts.userId, userId))
    .orderBy(desc(facebookAccounts.createdAt));

  return rows.map((r) => ({
    ...r,
    accessToken: (() => {
      try {
        return decrypt(r.accessToken);
      } catch {
        return "";
      }
    })(),
  })).filter((r) => r.accessToken !== "");
}

// ─── Helper: get single decrypted token with ownership check ──────────────────
async function getVerifiedToken(userId: number, fbAccountId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

  const [account] = await db
    .select({ userId: facebookAccounts.userId, accessToken: facebookAccounts.accessToken })
    .from(facebookAccounts)
    .where(eq(facebookAccounts.id, fbAccountId))
    .limit(1);

  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Facebook account not found" });
  }
  if (account.userId !== userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
  }

  try {
    return decrypt(account.accessToken);
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to decrypt token" });
  }
}

// ─── Helper: classify Facebook API errors ────────────────────────────────────
function classifyFbError(err: unknown): TRPCError {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("AUTH_ERROR") ||
    msg.includes("190") ||
    msg.includes("OAuthException") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return new TRPCError({
      code: "UNAUTHORIZED",
      message: "Facebook token expired or insufficient permissions. Please reconnect your account.",
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Failed to fetch data: ${msg}`,
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
export const adAnalyticsRouter = router({
  // ── List all ad accounts across all connected FB accounts ──────────────────
  listAdAccounts: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const tokens = await getUserFbTokens(userId);

    if (tokens.length === 0) {
      return [];
    }

    const results: Array<AdAccount & { fbAccountId: number; fbUserName: string }> = [];

    for (const token of tokens) {
      try {
        const accounts = await fetchAdAccounts(token.accessToken);
        for (const acc of accounts) {
          results.push({
            ...acc,
            fbAccountId: token.id,
            fbUserName: token.fbUserName,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Token expired or permission denied — surface as empty, not crash
        if (msg.includes("190") || msg.includes("OAuthException") || msg.includes("AUTH_ERROR")) {
          continue;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch ad accounts: ${msg}`,
        });
      }
    }

    return results;
  }),

  // ── Get account-level insights for a specific ad account ──────────────────
  getInsights: protectedProcedure
    .input(
      z.object({
        adAccountId: z.string().min(1),
        fbAccountId: z.number().int().positive(),
        datePreset: z.enum(DATE_PRESETS).optional().default("last_30d"),
      })
    )
    .query(async ({ ctx, input }) => {
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
      const fbDatePreset = FB_DATE_PRESET_MAP[input.datePreset];

      try {
        const insights = await fetchAdAccountInsights(input.adAccountId, accessToken, "USD", fbDatePreset);
        return insights;
      } catch (err) {
        throw classifyFbError(err);
      }
    }),

  // ── List campaigns for a specific ad account ──────────────────────────────
  listCampaigns: protectedProcedure
    .input(
      z.object({
        adAccountId: z.string().min(1),
        fbAccountId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);

      try {
        const campaigns = await fetchCampaigns(input.adAccountId, accessToken);
        return campaigns;
      } catch (err) {
        throw classifyFbError(err);
      }
    }),

  // ── Get campaign-level insights ───────────────────────────────────────────
  getCampaignInsights: protectedProcedure
    .input(
      z.object({
        adAccountId: z.string().min(1),
        fbAccountId: z.number().int().positive(),
        datePreset: z.enum(DATE_PRESETS).optional().default("last_30d"),
      })
    )
    .query(async ({ ctx, input }) => {
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
      const fbDatePreset = FB_DATE_PRESET_MAP[input.datePreset];

      // Get ad account currency
      let currency = "USD";
      try {
        const accounts = await fetchAdAccounts(accessToken);
        const account = accounts.find((a) => a.id === input.adAccountId);
        if (account) currency = account.currency;
      } catch {
        // Use default USD
      }

      try {
        const insights = await fetchCampaignInsights(input.adAccountId, accessToken, fbDatePreset, currency);
        return insights;
      } catch (err) {
        throw classifyFbError(err);
      }
    }),

  // ── Check CPL alerts — compare today vs 7-day avg ─────────────────────────
  checkAlerts: protectedProcedure
    .input(
      z.object({
        adAccountId: z.string().min(1),
        adAccountName: z.string(),
        fbAccountId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);

      let insights: InsightsSummary;
      try {
        insights = await fetchAdAccountInsights(input.adAccountId, accessToken);
      } catch {
        return { alerted: false };
      }

      const daily = insights.daily;
      if (daily.length < 8) return { alerted: false };

      // Today = last entry; 7-day avg = entries before today
      const today = daily[daily.length - 1];
      const last7 = daily.slice(-8, -1); // 7 days before today

      const avg7Cpl =
        last7.filter((d) => d.leads > 0).reduce((s, d) => s + d.cpl, 0) /
        (last7.filter((d) => d.leads > 0).length || 1);

      const avg7Leads =
        last7.reduce((s, d) => s + d.leads, 0) / last7.length;

      const alerts: string[] = [];

      // CPL spike: today's CPL > 130% of 7-day avg
      if (today.leads > 0 && avg7Cpl > 0 && today.cpl > avg7Cpl * 1.3) {
        alerts.push(
          `⚠️ Alert: High CPL detected on ${input.adAccountName}. Current: $${today.cpl.toFixed(2)} (7-day avg: $${avg7Cpl.toFixed(2)}, +${Math.round(((today.cpl - avg7Cpl) / avg7Cpl) * 100)}%)`
        );
      }

      // Lead volume drop: today's leads < 50% of 7-day avg
      if (avg7Leads > 0 && today.leads < avg7Leads * 0.5) {
        alerts.push(
          `⚠️ Alert: Lead volume drop on ${input.adAccountName}. Today: ${today.leads} leads (7-day avg: ${avg7Leads.toFixed(1)}, -${Math.round(((avg7Leads - today.leads) / avg7Leads) * 100)}%)`
        );
      }

      if (alerts.length === 0) return { alerted: false };

      try {
        await notifyOwner({
          title: `Ad Performance Alert — ${input.adAccountName}`,
          content: alerts.join("\n\n"),
        });
      } catch {
        // Non-fatal
      }

      return { alerted: true, alerts };
    }),
});

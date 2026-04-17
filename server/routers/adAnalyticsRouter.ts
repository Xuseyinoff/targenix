/**
 * adAnalyticsRouter.ts
 *
 * tRPC procedures for Business Tools → Ads Manager.
 *
 * Architecture: DB-first (stale-while-revalidate)
 *  1. Read from DB cache (adAccountsCache, campaignsCache, campaignInsightsCache, adSetsCache)
 *  2. If data is stale (>8 min) or missing → trigger background sync
 *  3. Return cached data immediately (fast response)
 *  4. syncNow → force immediate sync for a specific FB account
 *
 * Graph API is NEVER called on every page load.
 * All data flows: Facebook API → DB cache → Frontend.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { decrypt } from "../encryption";
import {
  facebookAccounts,
  adAccountsCache,
  campaignsCache,
  campaignInsightsCache,
  adSetsCache,
  leads,
} from "../../drizzle/schema";
import { eq, and, desc, asc, sql, inArray, isNotNull } from "drizzle-orm";
import {
  syncFbAccountData,
  syncAdSetsForCampaign,
  isStale,
} from "../services/adsSyncService";
import { notifyOwner } from "../_core/notification";
import { fetchAdAccountInsights } from "../services/adAccountsService";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { getDashboardDayUtcBounds } from "../lib/dashboardTimezone";
import { gte, lt } from "drizzle-orm";

// ─── Date preset validation ───────────────────────────────────────────────────
const DATE_PRESETS = ["today", "yesterday", "last_7d", "last_30d"] as const;
type DatePreset = typeof DATE_PRESETS[number];

// Frontend preset → DB cache key (only last_7d and last_30d are synced by background job)
const CACHE_PRESET_MAP: Record<DatePreset, string> = {
  today: "today",
  yesterday: "yesterday",
  last_7d: "last_7d",
  last_30d: "last_30d",
};

// ─── Helper: get decrypted token with ownership check ─────────────────────────
async function getVerifiedToken(userId: number, fbAccountId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

  const [account] = await db
    .select({ userId: facebookAccounts.userId, accessToken: facebookAccounts.accessToken })
    .from(facebookAccounts)
    .where(eq(facebookAccounts.id, fbAccountId))
    .limit(1);

  if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Facebook account not found" });
  if (account.userId !== userId) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });

  try {
    return decrypt(account.accessToken);
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to decrypt token" });
  }
}

// ─── Helper: get all decrypted tokens for a user ─────────────────────────────
async function getUserFbAccounts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(facebookAccounts)
    .where(eq(facebookAccounts.userId, userId))
    .orderBy(desc(facebookAccounts.createdAt));
}

// ─── Helper: assert authenticated user id (defence-in-depth) ─────────────────
function requireUserId(ctx: { user?: { id: number } | null }): number {
  if (!ctx.user?.id) throw new TRPCError({ code: "UNAUTHORIZED" });
  return ctx.user.id;
}

// ─── Helper: classify Facebook API errors ────────────────────────────────────
function classifyFbError(err: unknown): TRPCError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("AUTH_ERROR") || msg.includes("190") || msg.includes("OAuthException") || msg.includes("401") || msg.includes("403")) {
    return new TRPCError({
      code: "UNAUTHORIZED",
      message: "Facebook token expired or insufficient permissions. Please reconnect your account.",
    });
  }
  console.error("[adAnalytics] Internal error:", msg);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch analytics data. Please try again later." });
}

// ─── Shared mapper ───────────────────────────────────────────────────────────
function mapAdAccount(a: {
  fbAdAccountId: string; facebookAccountId: number; fbUserName: string | null;
  name: string; status: string; statusCode: number; currency: string;
  timezone: string | null; balance: string; amountSpent: string;
  minDailyBudget: string; lastSyncedAt: Date | null;
}) {
  return {
    id: a.fbAdAccountId,
    accountId: a.fbAdAccountId.replace("act_", ""),
    fbAccountId: a.facebookAccountId,
    fbUserName: a.fbUserName ?? "",
    name: a.name,
    status: a.status as "ACTIVE" | "DISABLED" | "UNSETTLED" | "PENDING_RISK_REVIEW" | "PENDING_SETTLEMENT" | "IN_GRACE_PERIOD" | "PENDING_CLOSURE" | "CLOSED" | "ANY_ACTIVE" | "ANY_CLOSED" | "UNKNOWN",
    statusCode: a.statusCode,
    currency: a.currency,
    timezone: a.timezone ?? "",
    balance: a.balance,
    amountSpent: a.amountSpent,
    minDailyBudget: a.minDailyBudget,
    lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────
export const adAnalyticsRouter = router({

  // ── List ad accounts — reads from DB, triggers background sync if stale ────
  listAdAccounts: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) return [];

    // Read from DB cache (join with facebookAccounts to get fbUserName)
    const cached = await db
      .select({
        id: adAccountsCache.id,
        userId: adAccountsCache.userId,
        facebookAccountId: adAccountsCache.facebookAccountId,
        fbAdAccountId: adAccountsCache.fbAdAccountId,
        name: adAccountsCache.name,
        status: adAccountsCache.status,
        statusCode: adAccountsCache.statusCode,
        currency: adAccountsCache.currency,
        timezone: adAccountsCache.timezone,
        balance: adAccountsCache.balance,
        amountSpent: adAccountsCache.amountSpent,
        minDailyBudget: adAccountsCache.minDailyBudget,
        lastSyncedAt: adAccountsCache.lastSyncedAt,
        fbUserName: facebookAccounts.fbUserName,
      })
      .from(adAccountsCache)
      .leftJoin(facebookAccounts, eq(adAccountsCache.facebookAccountId, facebookAccounts.id))
      .where(eq(adAccountsCache.userId, userId))
      .orderBy(asc(adAccountsCache.name));

    const fbAccounts = await getUserFbAccounts(userId);

    if (cached.length === 0 && fbAccounts.length > 0) {
      // ── First load: cache empty → sync synchronously so user sees data immediately ──
      for (const fbAccount of fbAccounts) {
        try {
          const accessToken = decrypt(fbAccount.accessToken);
          await syncFbAccountData(userId, fbAccount.id, accessToken);
        } catch (err) {
          console.error(`[adAnalytics] initial sync failed for fbacc=${fbAccount.id}:`, err instanceof Error ? err.message : err);
        }
      }
      // Re-read from cache after sync
      const fresh = await db
        .select({
          id: adAccountsCache.id,
          userId: adAccountsCache.userId,
          facebookAccountId: adAccountsCache.facebookAccountId,
          fbAdAccountId: adAccountsCache.fbAdAccountId,
          name: adAccountsCache.name,
          status: adAccountsCache.status,
          statusCode: adAccountsCache.statusCode,
          currency: adAccountsCache.currency,
          timezone: adAccountsCache.timezone,
          balance: adAccountsCache.balance,
          amountSpent: adAccountsCache.amountSpent,
          minDailyBudget: adAccountsCache.minDailyBudget,
          lastSyncedAt: adAccountsCache.lastSyncedAt,
          fbUserName: facebookAccounts.fbUserName,
        })
        .from(adAccountsCache)
        .leftJoin(facebookAccounts, eq(adAccountsCache.facebookAccountId, facebookAccounts.id))
        .where(eq(adAccountsCache.userId, userId))
        .orderBy(asc(adAccountsCache.name));
      return fresh.map(mapAdAccount);
    }

    // ── Stale data: return immediately + background sync ──────────────────────
    if (cached.some((a) => isStale(a.lastSyncedAt))) {
      for (const fbAccount of fbAccounts) {
        try {
          const accessToken = decrypt(fbAccount.accessToken);
          void syncFbAccountData(userId, fbAccount.id, accessToken).catch((e: unknown) =>
            console.error(`[adAnalytics] bg sync failed for fbacc=${fbAccount.id}:`, e instanceof Error ? e.message : e)
          );
        } catch { /* ignore */ }
      }
    }

    return cached.map(mapAdAccount);
  }),

  // ── List campaigns for an ad account — from DB ─────────────────────────────
  listCampaigns: protectedProcedure
    .input(z.object({
      adAccountId: z.string().min(1),
      fbAccountId: z.number().int().positive(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      // Ownership check
      await getVerifiedToken(ctx.user.id, input.fbAccountId);

      const cached = await db
        .select()
        .from(campaignsCache)
        .where(and(
          eq(campaignsCache.userId, ctx.user.id),
          eq(campaignsCache.fbAdAccountId, input.adAccountId)
        ))
        .orderBy(asc(campaignsCache.name));

      const mapCampaign = (c: typeof cached[number]) => ({
        id: c.fbCampaignId,
        name: c.name,
        status: c.status as "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED",
        objective: c.objective,
        dailyBudget: c.dailyBudget,
        lifetimeBudget: c.lifetimeBudget,
        lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      });

      if (cached.length === 0) {
        // First load — sync synchronously
        try {
          const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
          await syncFbAccountData(ctx.user.id, input.fbAccountId, accessToken);
        } catch (err) {
          console.error("[adAnalytics] initial campaign sync failed:", err instanceof Error ? err.message : err);
        }
        const fresh = await db
          .select()
          .from(campaignsCache)
          .where(and(
            eq(campaignsCache.userId, ctx.user.id),
            eq(campaignsCache.fbAdAccountId, input.adAccountId)
          ))
          .orderBy(asc(campaignsCache.name));
        return fresh.map(mapCampaign);
      }

      // Stale → background sync + return stale data
      if (cached.some((c) => isStale(c.lastSyncedAt))) {
        try {
          const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
          void syncFbAccountData(ctx.user.id, input.fbAccountId, accessToken).catch((e: unknown) =>
            console.error("[adAnalytics] bg campaign sync failed:", e instanceof Error ? e.message : e)
          );
        } catch { /* ignore */ }
      }

      return cached.map((c) => ({
        id: c.fbCampaignId,
        name: c.name,
        status: c.status as "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED",
        objective: c.objective,
        dailyBudget: c.dailyBudget,
        lifetimeBudget: c.lifetimeBudget,
        lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      }));
    }),

  // ── Get campaign-level insights — from DB ──────────────────────────────────
  getCampaignInsights: protectedProcedure
    .input(z.object({
      adAccountId: z.string().min(1),
      fbAccountId: z.number().int().positive(),
      datePreset: z.enum(DATE_PRESETS).optional().default("last_30d"),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
      const cacheKey = CACHE_PRESET_MAP[input.datePreset];

      const readInsights = () =>
        db!
          .select()
          .from(campaignInsightsCache)
          .where(and(
            eq(campaignInsightsCache.userId, ctx.user.id),
            eq(campaignInsightsCache.fbAdAccountId, input.adAccountId),
            eq(campaignInsightsCache.datePreset, cacheKey)
          ));

      let cachedInsights = await readInsights();

      // ── Cache miss: sync synchronously so user sees data on first switch ──────
      if (cachedInsights.length === 0) {
        try {
          await syncFbAccountData(ctx.user.id, input.fbAccountId, accessToken);
          cachedInsights = await readInsights();
        } catch (err) {
          console.error("[adAnalytics] sync failed for insights:", err instanceof Error ? err.message : err);
        }
      } else if (cachedInsights.some((r) => isStale(r.syncedAt))) {
        // ── Stale: return cached immediately + background refresh ──────────────
        void syncFbAccountData(ctx.user.id, input.fbAccountId, accessToken).catch((e: unknown) =>
          console.error("[adAnalytics] bg insights sync failed:", e instanceof Error ? e.message : e)
        );
      }

      // Get currency from ad accounts cache
      const [accountMeta] = await db
        .select({ currency: adAccountsCache.currency })
        .from(adAccountsCache)
        .where(and(
          eq(adAccountsCache.userId, ctx.user.id),
          eq(adAccountsCache.fbAdAccountId, input.adAccountId)
        ))
        .limit(1);

      const currency = accountMeta?.currency ?? "USD";

      // Build response from cache
      const campaigns = cachedInsights.map((row) => ({
        campaignId: row.fbCampaignId,
        campaignName: row.fbCampaignId, // will be enriched below
        spend: parseFloat(row.spend),
        impressions: row.impressions,
        clicks: row.clicks,
        leads: row.leads,
        cpl: parseFloat(row.cpl),
        ctr: parseFloat(row.ctr),
        conversionRate: parseFloat(row.conversionRate),
      }));

      // Enrich with campaign names from campaignsCache
      if (campaigns.length > 0) {
        const campaignRows = await db
          .select({ fbCampaignId: campaignsCache.fbCampaignId, name: campaignsCache.name })
          .from(campaignsCache)
          .where(and(
            eq(campaignsCache.userId, ctx.user.id),
            eq(campaignsCache.fbAdAccountId, input.adAccountId)
          ));
        const nameMap = new Map(campaignRows.map((c) => [c.fbCampaignId, c.name]));
        for (const c of campaigns) {
          c.campaignName = nameMap.get(c.campaignId) ?? c.campaignId;
        }
      }

      // Aggregate totals
      const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
      const totalLeads = campaigns.reduce((s, c) => s + c.leads, 0);
      const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
      const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
      const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0;
      const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

      return {
        datePreset: input.datePreset,
        currency,
        totalSpend: Math.round(totalSpend * 100) / 100,
        totalLeads,
        totalImpressions,
        totalClicks,
        avgCpl: Math.round(avgCpl * 100) / 100,
        avgCtr: Math.round(avgCtr * 100) / 100,
        campaigns: campaigns.sort((a, b) => b.spend - a.spend),
      };
    }),

  // ── List ad sets for a campaign — from DB, synced on demand ───────────────
  listAdSets: protectedProcedure
    .input(z.object({
      adAccountId: z.string().min(1),
      fbAccountId: z.number().int().positive(),
      fbCampaignId: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);

      const cached = await db
        .select()
        .from(adSetsCache)
        .where(and(
          eq(adSetsCache.userId, ctx.user.id),
          eq(adSetsCache.fbCampaignId, input.fbCampaignId)
        ))
        .orderBy(asc(adSetsCache.name));

      // Sync on demand if stale
      if (cached.length === 0 || cached.some((a) => isStale(a.lastSyncedAt))) {
        try {
          void syncAdSetsForCampaign(
            ctx.user.id,
            input.fbAccountId,
            input.adAccountId,
            input.fbCampaignId,
            accessToken
          ).catch((e: unknown) =>
            console.error("[adAnalytics] ad sets sync failed:", e instanceof Error ? e.message : e)
          );
        } catch { /* ignore */ }
      }

      return cached.map((a) => ({
        id: a.fbAdSetId,
        name: a.name,
        status: a.status as "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED",
        dailyBudget: a.dailyBudget,
        lifetimeBudget: a.lifetimeBudget,
        optimizationGoal: a.optimizationGoal ?? "",
        billingEvent: a.billingEvent ?? "",
        lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
      }));
    }),

  // ── Force sync for a specific FB account ──────────────────────────────────
  syncNow: protectedProcedure
    .input(z.object({
      fbAccountId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "adSyncNow", { max: 3, windowMs: 5 * 60_000, message: "Too many sync requests. Max 3 per 5 minutes." });
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
      try {
        const result = await syncFbAccountData(ctx.user.id, input.fbAccountId, accessToken);
        return { success: true, ...result };
      } catch (err) {
        throw classifyFbError(err);
      }
    }),

  // ── Get sync status for all FB accounts ───────────────────────────────────
  getSyncStatus: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const fbAccounts = await getUserFbAccounts(ctx.user.id);

    const statuses = await Promise.all(
      fbAccounts.map(async (fbAcc) => {
        // Find the most recent sync time across all ad accounts for this FB account
        const [latest] = await db
          .select({ lastSyncedAt: adAccountsCache.lastSyncedAt })
          .from(adAccountsCache)
          .where(and(
            eq(adAccountsCache.userId, ctx.user.id),
            eq(adAccountsCache.facebookAccountId, fbAcc.id)
          ))
          .orderBy(desc(adAccountsCache.lastSyncedAt))
          .limit(1);

        const lastSyncedAt = latest?.lastSyncedAt ?? null;
        return {
          fbAccountId: fbAcc.id,
          fbUserName: fbAcc.fbUserName,
          lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
          isStale: isStale(lastSyncedAt),
          tokenExpiresAt: fbAcc.tokenExpiresAt?.toISOString() ?? null,
        };
      })
    );

    return statuses;
  }),

  // ── Account-level insights (for Analytics page) ────────────────────────────
  getInsights: protectedProcedure
    .input(z.object({
      adAccountId: z.string().min(1),
      fbAccountId: z.number().int().positive(),
      datePreset: z.enum(DATE_PRESETS).optional().default("last_30d"),
    }))
    .query(async ({ ctx, input }) => {
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
      const FB_DATE_PRESET_MAP: Record<DatePreset, string> = {
        today: "today", yesterday: "yesterday", last_7d: "last_7d", last_30d: "last_30d",
      };
      const fbDatePreset = FB_DATE_PRESET_MAP[input.datePreset];
      try {
        const insights = await fetchAdAccountInsights(input.adAccountId, accessToken, "USD", fbDatePreset);
        return insights;
      } catch (err) {
        throw classifyFbError(err);
      }
    }),

  // ── Lead cost summary (admin only, DB-only, no FB API calls) ─────────────
  getLeadCostSummary: adminProcedure
    .input(z.object({
      dateRange: z.enum(DATE_PRESETS).default("today"),
      fbAccountId: z.number().int().positive().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx);
      const db = await getDb();

      const emptyTotals = { totalLeads: 0, sentLeads: 0, failedLeads: 0, pendingLeads: 0, spend: 0, cplTotal: null as number | null, cplSent: null as number | null };
      if (!db) return { dateRange: input.dateRange, campaigns: [], totals: emptyTotals, lastSyncedAt: null, isStale: true };

      const { dateRange } = input;

      // Use Tashkent-aware UTC bounds (same as getOrderStats) so "today" means
      // the same calendar day across all dashboard cards, regardless of MySQL server TZ.
      const todayBounds = getDashboardDayUtcBounds();
      const yesterdayBounds = getDashboardDayUtcBounds(new Date(todayBounds.start.getTime() - 1));
      const dateCondition = {
        today:     and(gte(leads.createdAt, todayBounds.start),     lt(leads.createdAt, todayBounds.end)),
        yesterday: and(gte(leads.createdAt, yesterdayBounds.start), lt(leads.createdAt, yesterdayBounds.end)),
        last_7d:   gte(leads.createdAt, new Date(todayBounds.start.getTime() - 6 * 24 * 60 * 60 * 1000)),
        last_30d:  gte(leads.createdAt, new Date(todayBounds.start.getTime() - 29 * 24 * 60 * 60 * 1000)),
      }[dateRange];

      // 1. Lead counts per campaignId broken down by deliveryStatus — scoped to this user only
      const leadCounts = await db
        .select({
          campaignId:   leads.campaignId,
          totalLeads:   sql<number>`COUNT(*)`,
          sentLeads:    sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'SUCCESS' THEN 1 ELSE 0 END)`,
          failedLeads:  sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'FAILED' THEN 1 ELSE 0 END)`,
          pendingLeads: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} IN ('PENDING','PROCESSING') THEN 1 ELSE 0 END)`,
        })
        .from(leads)
        .where(and(eq(leads.userId, userId), isNotNull(leads.campaignId), dateCondition))
        .groupBy(leads.campaignId);

      if (leadCounts.length === 0) {
        return { dateRange, campaigns: [], totals: emptyTotals, lastSyncedAt: null, isStale: true };
      }

      const campaignIds = leadCounts.map((l) => l.campaignId!).filter(Boolean);

      // 2. Spend from campaignInsightsCache — scoped to this user only
      const insightWhere = input.fbAccountId
        ? and(
            eq(campaignInsightsCache.userId, userId),
            eq(campaignInsightsCache.facebookAccountId, input.fbAccountId),
            inArray(campaignInsightsCache.fbCampaignId, campaignIds),
            eq(campaignInsightsCache.datePreset, dateRange),
          )
        : and(
            eq(campaignInsightsCache.userId, userId),
            inArray(campaignInsightsCache.fbCampaignId, campaignIds),
            eq(campaignInsightsCache.datePreset, dateRange),
          );

      const insightRows = await db
        .select({
          fbCampaignId: campaignInsightsCache.fbCampaignId,
          fbAdAccountId: campaignInsightsCache.fbAdAccountId,
          spend: campaignInsightsCache.spend,
          syncedAt: campaignInsightsCache.syncedAt,
        })
        .from(campaignInsightsCache)
        .where(insightWhere);

      // 3. Campaign names — scoped to this user only
      const campaignRows = await db
        .select({ fbCampaignId: campaignsCache.fbCampaignId, name: campaignsCache.name })
        .from(campaignsCache)
        .where(and(eq(campaignsCache.userId, userId), inArray(campaignsCache.fbCampaignId, campaignIds)));

      // 4. Currency per ad account — scoped to this user only
      const adAccountIds = Array.from(new Set(insightRows.map((r) => r.fbAdAccountId)));
      const currencyMap = new Map<string, string>();
      if (adAccountIds.length > 0) {
        const accountRows = await db
          .select({ fbAdAccountId: adAccountsCache.fbAdAccountId, currency: adAccountsCache.currency })
          .from(adAccountsCache)
          .where(and(eq(adAccountsCache.userId, userId), inArray(adAccountsCache.fbAdAccountId, adAccountIds)));
        for (const r of accountRows) currencyMap.set(r.fbAdAccountId, r.currency);
      }

      const insightMap = new Map(insightRows.map((r) => [r.fbCampaignId, r]));
      const nameMap = new Map(campaignRows.map((r) => [r.fbCampaignId, r.name]));

      const campaigns = leadCounts.map((l) => {
        const insight = insightMap.get(l.campaignId!);
        const spendAvailable = !!insight;
        const spendRaw = insight ? parseFloat(insight.spend) : null;
        const spend = spendRaw !== null ? Math.round(spendRaw * 100) / 100 : null;
        const totalLeads   = Number(l.totalLeads);
        const sentLeads    = Number(l.sentLeads ?? 0);
        const failedLeads  = Number(l.failedLeads ?? 0);
        const pendingLeads = Number(l.pendingLeads ?? 0);
        // Zero-division guarded: null when divisor is 0
        const cplTotal = spendRaw !== null && totalLeads > 0 ? Math.round((spendRaw / totalLeads) * 100) / 100 : null;
        const cplSent  = spendRaw !== null && sentLeads  > 0 ? Math.round((spendRaw / sentLeads)  * 100) / 100 : null;
        return {
          campaignId: l.campaignId!,
          campaignName: nameMap.get(l.campaignId!) ?? l.campaignId!,
          totalLeads,
          sentLeads,
          failedLeads,
          pendingLeads,
          spend,
          spendAvailable,
          spendNote: !spendAvailable ? ("not_synced_yet" as const) : null,
          cplTotal,
          cplSent,
          currency: insight ? (currencyMap.get(insight.fbAdAccountId) ?? "USD") : "USD",
        };
      }).sort((a, b) => b.totalLeads - a.totalLeads);

      const totTotalLeads   = campaigns.reduce((s, r) => s + r.totalLeads,   0);
      const totSentLeads    = campaigns.reduce((s, r) => s + r.sentLeads,    0);
      const totFailedLeads  = campaigns.reduce((s, r) => s + r.failedLeads,  0);
      const totPendingLeads = campaigns.reduce((s, r) => s + r.pendingLeads, 0);
      const totSpend = campaigns.reduce((s, r) => s + (r.spend ?? 0), 0);
      const totCplTotal = totTotalLeads > 0 && totSpend > 0 ? Math.round((totSpend / totTotalLeads) * 100) / 100 : null;
      const totCplSent  = totSentLeads  > 0 && totSpend > 0 ? Math.round((totSpend / totSentLeads)  * 100) / 100 : null;

      const latestSyncedAt = insightRows
        .map((r) => r.syncedAt)
        .filter(Boolean)
        .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null;

      const STALE_MS = 60 * 60 * 1000; // 1 hour
      const cacheIsStale = !latestSyncedAt || Date.now() - latestSyncedAt.getTime() > STALE_MS;

      return {
        dateRange,
        campaigns,
        totals: {
          totalLeads: totTotalLeads,
          sentLeads: totSentLeads,
          failedLeads: totFailedLeads,
          pendingLeads: totPendingLeads,
          spend: Math.round(totSpend * 100) / 100,
          cplTotal: totCplTotal,
          cplSent: totCplSent,
        },
        lastSyncedAt: latestSyncedAt?.toISOString() ?? null,
        isStale: cacheIsStale,
      };
    }),

  // ── CPL alert check ────────────────────────────────────────────────────────
  checkAlerts: protectedProcedure
    .input(z.object({
      adAccountId: z.string().min(1),
      adAccountName: z.string(),
      fbAccountId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const accessToken = await getVerifiedToken(ctx.user.id, input.fbAccountId);
      let insights;
      try {
        insights = await fetchAdAccountInsights(input.adAccountId, accessToken);
      } catch {
        return { alerted: false };
      }

      const daily = insights.daily;
      if (daily.length < 8) return { alerted: false };

      const today = daily[daily.length - 1];
      const last7 = daily.slice(-8, -1);
      const avg7Cpl = last7.filter((d) => d.leads > 0).reduce((s, d) => s + d.cpl, 0) /
        (last7.filter((d) => d.leads > 0).length || 1);
      const avg7Leads = last7.reduce((s, d) => s + d.leads, 0) / last7.length;
      const alerts: string[] = [];

      if (today.leads > 0 && avg7Cpl > 0 && today.cpl > avg7Cpl * 1.3) {
        alerts.push(`⚠️ High CPL on ${input.adAccountName}. Current: $${today.cpl.toFixed(2)} (7d avg: $${avg7Cpl.toFixed(2)}, +${Math.round(((today.cpl - avg7Cpl) / avg7Cpl) * 100)}%)`);
      }
      if (avg7Leads > 0 && today.leads < avg7Leads * 0.5) {
        alerts.push(`⚠️ Lead volume drop on ${input.adAccountName}. Today: ${today.leads} (7d avg: ${avg7Leads.toFixed(1)}, -${Math.round(((avg7Leads - today.leads) / avg7Leads) * 100)}%)`);
      }
      if (alerts.length === 0) return { alerted: false };

      try {
        await notifyOwner({ title: `Ad Alert — ${input.adAccountName}`, content: alerts.join("\n\n") });
      } catch { /* non-fatal */ }

      return { alerted: true, alerts };
    }),
});

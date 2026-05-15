/**
 * adsSyncService.ts
 *
 * Syncs Facebook Ads data (ad accounts, campaigns, insights, ad sets)
 * from Meta Graph API into the local DB cache tables.
 *
 * Design principles:
 *  - NEVER called on every page load — only by background scheduler or manual trigger
 *  - Uses a single insights call per ad account (not per-campaign)
 *  - Upserts to DB so re-runs are idempotent
 *  - Respects userId isolation — each user's data is isolated
 *
 * Hierarchy synced:
 *   facebookAccounts → adAccounts → campaigns + campaignInsights
 *                                      → adSets (on-demand per campaign)
 */

import axios from "axios";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { log } from "./appLogger";
import {
  facebookAccounts,
  adAccounts,
  campaigns,
  campaignInsights,
  campaignDailyInsights,
  adSets,
} from "../../drizzle/schema";
import { decrypt } from "../encryption";
import {
  generateAppSecretProof,
  graphMarketingFormPost,
  GraphDataList,
  normalizeFacebookAccessToken,
} from "./adAccountsService";

// Date presets to sync — all 4 are cached so every UI option has data
const SYNC_DATE_PRESETS = ["last_30d", "last_7d", "today", "yesterday"] as const;
type SyncDatePreset = typeof SYNC_DATE_PRESETS[number];

// Stale threshold: data older than this triggers a re-sync
const STALE_THRESHOLD_MS = 8 * 60 * 1000; // 8 minutes

// ─── Raw API types ────────────────────────────────────────────────────────────
interface RawAdAccount {
  id: string;
  name: string;
  account_id: string;
  account_status: number;
  currency: string;
  timezone_name?: string;
  balance: string;
  amount_spent: string;
  min_daily_budget: string;
  /** Business Manager that owns the ad account. Absent for personal ad
   *  accounts that aren't linked to a BM. Captured for Insights grouping. */
  business?: { id: string; name?: string };
}

interface RawCampaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  daily_budget?: string;
  lifetime_budget?: string;
}

interface RawInsightAction {
  action_type: string;
  value: string;
}

interface RawCampaignInsight {
  campaign_id: string;
  campaign_name: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: RawInsightAction[];
}

/**
 * Daily-granularity insight row from `/{ad_account}/insights?time_increment=1`.
 * date_start / date_stop are identical when time_increment=1 — each row
 * represents exactly one day.
 */
interface RawDailyInsight {
  campaign_id: string;
  date_start: string;
  date_stop: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: RawInsightAction[];
}

/**
 * Convert FB's decimal-string spend ("12.34" / "35000.00") into the
 * SMALLEST unit of the currency. Mirrors the storage convention used in
 * fact_attribution_daily.spendAmount and campaign_daily_insights.spend.
 *
 *  - USD / fractional currencies: multiply by 100 → cents.
 *  - UZS / no-subunit currencies: round to integer → so'm.
 *
 * We only need to support the v1 currency set (USD + UZS); future
 * currencies inherit the integer-rounding default until v2 adds a proper
 * subunit table.
 */
function spendToSmallestUnit(rawSpend: string, currency: string): number {
  const n = parseFloat(rawSpend ?? "0");
  if (!Number.isFinite(n) || n < 0) return 0;
  if (currency === "USD" || currency === "EUR" || currency === "GBP") {
    return Math.round(n * 100);
  }
  return Math.round(n);
}

interface RawAdSet {
  id: string;
  name: string;
  status: string;
  campaign_id: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
}

const STATUS_MAP: Record<number, string> = {
  1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 4: "PENDING_RISK_REVIEW",
  5: "PENDING_SETTLEMENT", 6: "IN_GRACE_PERIOD", 7: "PENDING_CLOSURE",
  8: "CLOSED", 9: "ANY_ACTIVE", 10: "ANY_CLOSED",
};

// Map frontend preset labels → Facebook API date_preset values
const FB_PRESET_MAP: Record<SyncDatePreset, string> = {
  last_30d: "last_30d",
  last_7d: "last_7d",
  today: "today",
  yesterday: "yesterday",
};

// ─── isStale helper ───────────────────────────────────────────────────────────
export function isStale(lastSyncedAt: Date | null): boolean {
  if (!lastSyncedAt) return true;
  return Date.now() - lastSyncedAt.getTime() > STALE_THRESHOLD_MS;
}

// ─── Sync a single Facebook account ──────────────────────────────────────────
export async function syncFbAccountData(
  userId: number,
  facebookAccountId: number,
  accessToken: string
): Promise<{ accounts: number; campaigns: number; insights: number; dailyInsights: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const token = normalizeFacebookAccessToken(accessToken);

const appsecretProof = generateAppSecretProof(token);
  const now = new Date();
  let accountsSynced = 0;
  let campaignsSynced = 0;
  let insightsSynced = 0;
  let dailyInsightsSynced = 0;

  // ── 1. Fetch & upsert ad accounts ──────────────────────────────────────────
  let adAccountsList: RawAdAccount[] = [];
  try {
    const res = await graphMarketingFormPost<GraphDataList<RawAdAccount>>(
      "/me/adaccounts",
      {
        fields: "id,name,account_id,account_status,currency,timezone_name,balance,amount_spent,min_daily_budget,business{id,name}",
        access_token: token,
        appsecret_proof: appsecretProof,
        limit: "200",
      },
      20000,
    );
    adAccountsList = res.data ?? [];
  } catch (err) {
    await log.error(
      "FACEBOOK",
      "[adsSyncService] Failed to fetch ad accounts",
      { error: err instanceof Error ? err.message : String(err) },
    );
    throw err;
  }

  for (const raw of adAccountsList) {
    // BM is absent for personal ad accounts not linked to a Business Manager.
    // Trim to column lengths so a long custom BM name doesn't blow up the upsert.
    const bmId = raw.business?.id ? String(raw.business.id).slice(0, 64) : null;
    const bmName = raw.business?.name ? String(raw.business.name).slice(0, 255) : null;

    await db
      .insert(adAccounts)
      .values({
        userId,
        facebookAccountId,
        fbAdAccountId: raw.id,
        name: raw.name ?? "",
        status: STATUS_MAP[raw.account_status] ?? "UNKNOWN",
        statusCode: raw.account_status ?? 0,
        currency: raw.currency ?? "USD",
        timezone: raw.timezone_name ?? null,
        balance: raw.balance ?? "0",
        amountSpent: raw.amount_spent ?? "0",
        minDailyBudget: raw.min_daily_budget ?? "0",
        bmId,
        bmName,
        lastSyncedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          name: raw.name ?? "",
          status: STATUS_MAP[raw.account_status] ?? "UNKNOWN",
          statusCode: raw.account_status ?? 0,
          currency: raw.currency ?? "USD",
          timezone: raw.timezone_name ?? null,
          balance: raw.balance ?? "0",
          amountSpent: raw.amount_spent ?? "0",
          minDailyBudget: raw.min_daily_budget ?? "0",
          bmId,
          bmName,
          lastSyncedAt: now,
        },
      });
    accountsSynced++;
  }

  // ── 2. For each ad account: fetch campaigns + insights ─────────────────────
  for (const adAccount of adAccountsList) {
    const adAccountId = adAccount.id;
    const currency = adAccount.currency ?? "USD";

    // 2a. Fetch campaigns (single API call, returns all campaigns)
    let rawCampaigns: RawCampaign[] = [];
    try {
      const res = await graphMarketingFormPost<GraphDataList<RawCampaign>>(
        `/${adAccountId}/campaigns`,
        {
          fields: "id,name,status,objective,daily_budget,lifetime_budget",
          effective_status: JSON.stringify(["ACTIVE", "PAUSED"]),
          access_token: token,
          appsecret_proof: appsecretProof,
          limit: "200",
        },
        20000,
      );
      rawCampaigns = res.data ?? [];
    } catch (err) {
      await log.error(
        "FACEBOOK",
        `[adsSyncService] Failed to fetch campaigns for ${adAccountId}`,
        { adAccountId, error: err instanceof Error ? err.message : String(err) },
      );
      continue; // skip this account if campaigns fail
    }

    // Upsert campaigns
    for (const raw of rawCampaigns) {
      await db
        .insert(campaigns)
        .values({
          userId,
          facebookAccountId,
          fbAdAccountId: adAccountId,
          fbCampaignId: raw.id,
          name: raw.name ?? "",
          status: raw.status ?? "ACTIVE",
          objective: raw.objective ?? "",
          dailyBudget: raw.daily_budget ?? "0",
          lifetimeBudget: raw.lifetime_budget ?? "0",
          lastSyncedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            name: raw.name ?? "",
            status: raw.status ?? "ACTIVE",
            objective: raw.objective ?? "",
            dailyBudget: raw.daily_budget ?? "0",
            lifetimeBudget: raw.lifetime_budget ?? "0",
            lastSyncedAt: now,
          },
        });
      campaignsSynced++;
    }

    // 2b. Fetch campaign-level insights (single call per ad account per date preset)
    for (const preset of SYNC_DATE_PRESETS) {
      const fbPreset = FB_PRESET_MAP[preset];
      let rawInsights: RawCampaignInsight[] = [];

      try {
        const res = await graphMarketingFormPost<GraphDataList<RawCampaignInsight>>(
          `/${adAccountId}/insights`,
          {
            fields: "campaign_id,campaign_name,spend,actions,impressions,clicks",
            level: "campaign",
            date_preset: fbPreset,
            action_breakdowns: "action_type",
            access_token: token,
            appsecret_proof: appsecretProof,
            limit: "200",
          },
          30000,
        );
        rawInsights = res.data ?? [];
      } catch (err: unknown) {
        const e = err as { response?: { status?: number; data?: { error?: { message?: string; code?: unknown; type?: string } } }; message?: string };
        const fbError = e?.response?.data?.error?.message ?? "unknown";
        const fbCode = e?.response?.data?.error?.code ?? "unknown";
        const fbType = e?.response?.data?.error?.type ?? "unknown";
        await log.error(
          "FACEBOOK",
          `[adsSyncService] Failed insights ${adAccountId} (${preset}): FB Error: ${fbError} | Code: ${fbCode} | Type: ${fbType} | HTTP: ${e?.response?.status}`,
          { adAccountId, preset, fbError, fbCode, fbType, httpStatus: e?.response?.status },
        );
        continue;
      }

      for (const raw of rawInsights) {
        const spend = parseFloat(raw.spend ?? "0");
        const impressions = parseInt(raw.impressions ?? "0", 10);
        const clicks = parseInt(raw.clicks ?? "0", 10);
        const leadAction = (raw.actions ?? []).find(
          (a) => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped"
        );
        const leads = leadAction ? parseInt(leadAction.value, 10) : 0;
        const cpl = leads > 0 ? spend / leads : 0;
        const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
        const conversionRate = clicks > 0 ? (leads / clicks) * 100 : 0;

        await db
          .insert(campaignInsights)
          .values({
            userId,
            facebookAccountId,
            fbAdAccountId: adAccountId,
            fbCampaignId: raw.campaign_id,
            datePreset: preset,
            spend: spend.toFixed(2),
            impressions,
            clicks,
            leads,
            ctr: ctr.toFixed(4),
            cpl: cpl.toFixed(4),
            conversionRate: conversionRate.toFixed(4),
            syncedAt: now,
          })
          .onDuplicateKeyUpdate({
            set: {
              spend: spend.toFixed(2),
              impressions,
              clicks,
              leads,
              ctr: ctr.toFixed(4),
              cpl: cpl.toFixed(4),
              conversionRate: conversionRate.toFixed(4),
              syncedAt: now,
            },
          });
        insightsSynced++;
      }
    }

    // 2c. Fetch DAILY-grain insights for the rollup (Phase 2).
    //
    // `time_increment=1` makes FB return one row per day instead of the
    // preset-aggregated total — that's exactly what fact_attribution_daily
    // needs. We always ask for last_7d so the data matches the rollup
    // worker's 7-day rebuild window. One call per ad account; the response
    // contains N campaigns × 7 days of rows.
    let rawDaily: RawDailyInsight[] = [];
    try {
      const res = await graphMarketingFormPost<GraphDataList<RawDailyInsight>>(
        `/${adAccountId}/insights`,
        {
          fields: "campaign_id,date_start,date_stop,spend,impressions,clicks,actions",
          level: "campaign",
          time_increment: "1",
          date_preset: "last_7d",
          action_breakdowns: "action_type",
          access_token: token,
          appsecret_proof: appsecretProof,
          limit: "1000",
        },
        45000,
      );
      rawDaily = res.data ?? [];
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: { message?: string; code?: unknown; type?: string } } }; message?: string };
      await log.warn(
        "FACEBOOK",
        `[adsSyncService] Daily insights failed for ${adAccountId}: ${e?.response?.data?.error?.message ?? e?.message ?? "unknown"}`,
        {
          adAccountId,
          fbError: e?.response?.data?.error?.message ?? null,
          fbCode: e?.response?.data?.error?.code ?? null,
          httpStatus: e?.response?.status ?? null,
        },
      );
      rawDaily = [];
    }

    for (const raw of rawDaily) {
      // date_start === date_stop when time_increment=1, so use either.
      const date = raw.date_start;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const spendUnits = spendToSmallestUnit(raw.spend, currency);
      const impressions = parseInt(raw.impressions ?? "0", 10) || 0;
      const clicks = parseInt(raw.clicks ?? "0", 10) || 0;
      const leadAction = (raw.actions ?? []).find(
        (a) => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped",
      );
      const leadsReported = leadAction ? parseInt(leadAction.value, 10) || 0 : 0;

      await db
        .insert(campaignDailyInsights)
        .values({
          userId,
          fbAdAccountId: adAccountId,
          fbCampaignId: raw.campaign_id,
          date,
          spend: String(spendUnits),
          currency,
          impressions,
          clicks,
          leadsReported,
        })
        .onDuplicateKeyUpdate({
          set: {
            spend: String(spendUnits),
            currency,
            impressions,
            clicks,
            leadsReported,
          },
        });
      dailyInsightsSynced++;
    }
  }

  console.log(
    `[adsSyncService] userId=${userId} fbAccountId=${facebookAccountId}: ` +
    `${accountsSynced} accounts, ${campaignsSynced} campaigns, ${insightsSynced} insights, ${dailyInsightsSynced} daily-rows`
  );
  return {
    accounts: accountsSynced,
    campaigns: campaignsSynced,
    insights: insightsSynced,
    dailyInsights: dailyInsightsSynced,
  };
}

// ─── Sync ad sets for a specific campaign (on-demand) ────────────────────────
export async function syncAdSetsForCampaign(
  userId: number,
  facebookAccountId: number,
  fbAdAccountId: string,
  fbCampaignId: string,
  accessToken: string
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const token = normalizeFacebookAccessToken(accessToken);
  const appsecretProof = generateAppSecretProof(token);
  const now = new Date();

  let rawAdSets: RawAdSet[] = [];
  const res = await graphMarketingFormPost<GraphDataList<RawAdSet>>(
    `/${fbCampaignId}/adsets`,
    {
      fields: "id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event",
      access_token: token,
      appsecret_proof: appsecretProof,
      limit: "200",
    },
    20000,
  );
  rawAdSets = res.data ?? [];

  for (const raw of rawAdSets) {
    await db
      .insert(adSets)
      .values({
        userId,
        facebookAccountId,
        fbAdAccountId,
        fbCampaignId,
        fbAdSetId: raw.id,
        name: raw.name ?? "",
        status: raw.status ?? "ACTIVE",
        dailyBudget: raw.daily_budget ?? "0",
        lifetimeBudget: raw.lifetime_budget ?? "0",
        optimizationGoal: raw.optimization_goal ?? null,
        billingEvent: raw.billing_event ?? null,
        lastSyncedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          name: raw.name ?? "",
          status: raw.status ?? "ACTIVE",
          dailyBudget: raw.daily_budget ?? "0",
          lifetimeBudget: raw.lifetime_budget ?? "0",
          optimizationGoal: raw.optimization_goal ?? null,
          billingEvent: raw.billing_event ?? null,
          lastSyncedAt: now,
        },
      });
  }

  console.log(`[adsSyncService] Synced ${rawAdSets.length} ad sets for campaign ${fbCampaignId}`);
  return rawAdSets.length;
}

// ─── Sync all connected FB accounts for all users ────────────────────────────
// Called by the background scheduler every 10 minutes.
export async function syncAllUsersAdsData(): Promise<void> {
  const db = await getDb();
  if (!db) {
    await log.warn("SYSTEM", "[adsSyncService] DB not available, skipping global sync");
    return;
  }

  const accounts = await db.select().from(facebookAccounts);
  console.log(`[adsSyncService] Starting global sync for ${accounts.length} FB account(s)`);

  for (const account of accounts) {
    let accessToken: string;
    try {
      accessToken = decrypt(account.accessToken);
    } catch {
      await log.warn(
        "FACEBOOK",
        `[adsSyncService] Failed to decrypt token for userId=${account.userId} facebookAccountId=${account.id}`,
        { userId: account.userId, facebookAccountId: account.id },
      );
      continue;
    }

    try {
      await syncFbAccountData(account.userId, account.id, accessToken);
    } catch (err) {
      // Don't crash the whole sync if one account fails (e.g., expired token)
      let detail: string;
      if (axios.isAxiosError(err) && err.response) {
        detail = `${err.response.status} ${JSON.stringify(err.response.data)}`;
      } else {
        detail = err instanceof Error ? err.message : String(err);
      }
      await log.error(
        "FACEBOOK",
        `[adsSyncService] Sync failed for userId=${account.userId} facebookAccountId=${account.id}: ${detail}`,
        { userId: account.userId, facebookAccountId: account.id, detail },
      );
    }
  }

  console.log("[adsSyncService] Global sync complete");
}

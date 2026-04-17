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
 *   facebookAccounts → adAccountsCache → campaignsCache + campaignInsightsCache
 *                                      → adSetsCache (on-demand per campaign)
 */

import axios from "axios";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  facebookAccounts,
  adAccountsCache,
  campaignsCache,
  campaignInsightsCache,
  adSetsCache,
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
): Promise<{ accounts: number; campaigns: number; insights: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const token = normalizeFacebookAccessToken(accessToken);

const appsecretProof = generateAppSecretProof(token);
  const now = new Date();
  let accountsSynced = 0;
  let campaignsSynced = 0;
  let insightsSynced = 0;

  // ── 1. Fetch & upsert ad accounts ──────────────────────────────────────────
  let adAccountsList: RawAdAccount[] = [];
  try {
    const res = await graphMarketingFormPost<GraphDataList<RawAdAccount>>(
      "/me/adaccounts",
      {
        fields: "id,name,account_id,account_status,currency,timezone_name,balance,amount_spent,min_daily_budget",
        access_token: token,
        appsecret_proof: appsecretProof,
        limit: "200",
      },
      20000,
    );
    adAccountsList = res.data ?? [];
  } catch (err) {
    console.error("[adsSyncService] Failed to fetch ad accounts:", err instanceof Error ? err.message : err);
    throw err;
  }

  for (const raw of adAccountsList) {
    await db
      .insert(adAccountsCache)
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
      console.error(`[adsSyncService] Failed to fetch campaigns for ${adAccountId}:`, err instanceof Error ? err.message : err);
      continue; // skip this account if campaigns fail
    }

    // Upsert campaigns
    for (const raw of rawCampaigns) {
      await db
        .insert(campaignsCache)
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
        console.error(
          `[adsSyncService] Failed insights ${adAccountId} (${preset}):`,
          `FB Error: ${fbError} | Code: ${fbCode} | Type: ${fbType} | HTTP: ${e?.response?.status}`
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
          .insert(campaignInsightsCache)
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
  }

  console.log(
    `[adsSyncService] userId=${userId} fbAccountId=${facebookAccountId}: ` +
    `${accountsSynced} accounts, ${campaignsSynced} campaigns, ${insightsSynced} insights`
  );
  return { accounts: accountsSynced, campaigns: campaignsSynced, insights: insightsSynced };
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
      .insert(adSetsCache)
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
    console.warn("[adsSyncService] DB not available, skipping global sync");
    return;
  }

  const accounts = await db.select().from(facebookAccounts);
  console.log(`[adsSyncService] Starting global sync for ${accounts.length} FB account(s)`);

  for (const account of accounts) {
    let accessToken: string;
    try {
      accessToken = decrypt(account.accessToken);
    } catch {
      console.warn(
        `[adsSyncService] Failed to decrypt token for userId=${account.userId} facebookAccountId=${account.id}`,
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
      console.error(
        `[adsSyncService] Sync failed for userId=${account.userId} facebookAccountId=${account.id}:`,
        detail,
      );
    }
  }

  console.log("[adsSyncService] Global sync complete");
}

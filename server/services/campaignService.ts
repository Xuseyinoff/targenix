/**
 * campaignService.ts
 *
 * Fetches Facebook Campaign data and Campaign-level Insights from Meta Graph API v21.0.
 * - Uses appsecret_proof for all server-side calls (security requirement)
 * - Caches results for 10 minutes to avoid rate limiting
 * - Calculates CPL, CTR, and Conversion Rate per campaign
 */

import axios from "axios";
import {
  generateAppSecretProof,
  graphMarketingFormPost,
  GraphDataList,
  normalizeFacebookAccessToken,
} from "./adAccountsService";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── In-memory cache ──────────────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const campaignsCache = new Map<string, CacheEntry<Campaign[]>>();
const campaignInsightsCache = new Map<string, CacheEntry<CampaignInsightRow[]>>();

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Types ────────────────────────────────────────────────────────────────────
export type CampaignStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  objective: string;
  dailyBudget: string;    // in cents as string
  lifetimeBudget: string; // in cents as string
}

export interface CampaignInsightRow {
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cpl: number;           // cost per lead
  ctr: number;           // click-through rate %
  conversionRate: number; // leads / clicks %
}

export interface CampaignInsightsSummary {
  datePreset: string;
  totalSpend: number;
  totalLeads: number;
  totalImpressions: number;
  totalClicks: number;
  avgCpl: number;
  avgCtr: number;
  currency: string;
  campaigns: CampaignInsightRow[];
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

// ─── Fetch Campaigns ──────────────────────────────────────────────────────────
export async function fetchCampaigns(
  adAccountId: string,
  accessToken: string
): Promise<Campaign[]> {
  const token = normalizeFacebookAccessToken(accessToken);
  const cacheKey = `campaigns:${adAccountId}:${token.slice(-16)}`;
  const cached = cacheGet(campaignsCache, cacheKey);
  if (cached) return cached;

  const appsecretProof = generateAppSecretProof(token);

  let res;
  try {
    res = await graphMarketingFormPost<GraphDataList<RawCampaign>>(
      `/${adAccountId}/campaigns`,
      {
        fields: "id,name,status,objective,daily_budget,lifetime_budget",
        effective_status: JSON.stringify(["ACTIVE", "PAUSED"]),
        access_token: token,
        appsecret_proof: appsecretProof,
        limit: "100",
      },
      15000,
    );
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      console.error("[campaignService] Facebook API error:", JSON.stringify(err.response.data));
      const fbError = err.response.data?.error;
      const code = fbError?.code;
      const status = err.response.status;
      if (status === 401 || status === 403 || code === 190 || code === 200) {
        const authErr = new Error(`AUTH_ERROR: ${JSON.stringify(fbError)}`);
        (authErr as Error & { fbCode?: number; httpStatus?: number }).fbCode = code;
        (authErr as Error & { fbCode?: number; httpStatus?: number }).httpStatus = status;
        throw authErr;
      }
      throw new Error(`Facebook API ${status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }

  const campaigns: Campaign[] = (res.data ?? []).map((raw) => ({
    id: raw.id,
    name: raw.name,
    status: (raw.status as CampaignStatus) ?? "PAUSED",
    objective: raw.objective ?? "",
    dailyBudget: raw.daily_budget ?? "0",
    lifetimeBudget: raw.lifetime_budget ?? "0",
  }));

  cacheSet(campaignsCache, cacheKey, campaigns);
  return campaigns;
}

// ─── Fetch Campaign-Level Insights ───────────────────────────────────────────
export async function fetchCampaignInsights(
  adAccountId: string,
  accessToken: string,
  datePreset: string = "last_30d",
  currency: string = "USD"
): Promise<CampaignInsightsSummary> {
  const token = normalizeFacebookAccessToken(accessToken);
  const cacheKey = `campaign_insights:${adAccountId}:${datePreset}:${token.slice(-16)}`;
  const cached = cacheGet(campaignInsightsCache, cacheKey);
  if (cached) return buildCampaignSummary(cached, datePreset, currency);

  const appsecretProof = generateAppSecretProof(token);

  let res;
  try {
    res = await graphMarketingFormPost<GraphDataList<RawCampaignInsight>>(
      `/${adAccountId}/insights`,
      {
        fields: "campaign_id,campaign_name,spend,actions,impressions,clicks",
        level: "campaign",
        date_preset: datePreset,
        action_breakdowns: "action_type",
        access_token: token,
        appsecret_proof: appsecretProof,
        limit: "100",
      },
      20000,
    );
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      console.error("[campaignService] Insights API error:", JSON.stringify(err.response.data));
      const fbError = err.response.data?.error;
      const code = fbError?.code;
      const status = err.response.status;
      if (status === 401 || status === 403 || code === 190 || code === 200) {
        const authErr = new Error(`AUTH_ERROR: ${JSON.stringify(fbError)}`);
        (authErr as Error & { fbCode?: number; httpStatus?: number }).fbCode = code;
        (authErr as Error & { fbCode?: number; httpStatus?: number }).httpStatus = status;
        throw authErr;
      }
      throw new Error(`Facebook API ${status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }

  const rows: CampaignInsightRow[] = (res.data ?? []).map((raw) => {
    const spend = parseFloat(raw.spend ?? "0");
    const impressions = parseInt(raw.impressions ?? "0", 10);
    const clicks = parseInt(raw.clicks ?? "0", 10);

    // Extract lead count from actions array
    const leadAction = (raw.actions ?? []).find(
      (a) => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped"
    );
    const leads = leadAction ? parseInt(leadAction.value, 10) : 0;

    const cpl = leads > 0 ? spend / leads : 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const conversionRate = clicks > 0 ? (leads / clicks) * 100 : 0;

    return {
      campaignId: raw.campaign_id,
      campaignName: raw.campaign_name,
      spend: Math.round(spend * 100) / 100,
      impressions,
      clicks,
      leads,
      cpl: Math.round(cpl * 100) / 100,
      ctr: Math.round(ctr * 100) / 100,
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  });

  cacheSet(campaignInsightsCache, cacheKey, rows);
  return buildCampaignSummary(rows, datePreset, currency);
}

function buildCampaignSummary(
  rows: CampaignInsightRow[],
  datePreset: string,
  currency: string
): CampaignInsightsSummary {
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totalLeads = rows.reduce((s, r) => s + r.leads, 0);
  const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0;
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  return {
    datePreset,
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalLeads,
    totalImpressions,
    totalClicks,
    avgCpl: Math.round(avgCpl * 100) / 100,
    avgCtr: Math.round(avgCtr * 100) / 100,
    currency,
    campaigns: rows.sort((a, b) => b.spend - a.spend), // sort by spend desc
  };
}

// ─── Cache invalidation ───────────────────────────────────────────────────────
export function invalidateCampaignsCache(adAccountId: string, accessToken: string): void {
  const cacheKey = `campaigns:${adAccountId}:${accessToken.slice(-16)}`;
  campaignsCache.delete(cacheKey);
}

export function invalidateCampaignInsightsCache(adAccountId: string, accessToken: string): void {
  // Remove all date presets for this account
  Array.from(campaignInsightsCache.keys()).forEach((key) => {
    if (key.startsWith(`campaign_insights:${adAccountId}:`)) {
      campaignInsightsCache.delete(key);
    }
  });
}

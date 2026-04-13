/**
 * adAccountsService.ts
 *
 * Fetches Facebook Ad Accounts from Meta Graph API v21.0.
 * - Uses appsecret_proof for all server-side calls (security requirement)
 * - Caches results for 10 minutes per user token to avoid rate limiting
 * - Maps account_status integers to human-readable labels
 */

import axios from "axios";
import { createHmac } from "crypto";

const GRAPH = "https://graph.facebook.com/v21.0";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── In-memory cache ──────────────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const adAccountsCache = new Map<string, CacheEntry<AdAccount[]>>();
const insightsCache = new Map<string, CacheEntry<DailyInsight[]>>();

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

// ─── appsecret_proof ──────────────────────────────────────────────────────────
/**
 * Generates appsecret_proof = HMAC-SHA256(app_secret, access_token)
 * Required for all server-side Graph API calls for enhanced security.
 *
 * Reads `FACEBOOK_APP_SECRET` at call time (not a module snapshot) and trims
 * whitespace — Railway/copy-paste often adds a trailing newline, which breaks HMAC.
 */
export function generateAppSecretProof(accessToken: string): string {
  const secret = (process.env.FACEBOOK_APP_SECRET ?? "").trim();
  const token = (accessToken ?? "").trim();
  if (!secret) {
    throw new Error("FACEBOOK_APP_SECRET is missing or empty");
  }
  return createHmac("sha256", secret).update(token).digest("hex");
}

// ─── Types ────────────────────────────────────────────────────────────────────
export type AccountStatus =
  | "ACTIVE"
  | "DISABLED"
  | "UNSETTLED"
  | "PENDING_RISK_REVIEW"
  | "PENDING_SETTLEMENT"
  | "IN_GRACE_PERIOD"
  | "PENDING_CLOSURE"
  | "CLOSED"
  | "ANY_ACTIVE"
  | "ANY_CLOSED"
  | "UNKNOWN";

const STATUS_MAP: Record<number, AccountStatus> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  4: "PENDING_RISK_REVIEW",
  5: "PENDING_SETTLEMENT",
  6: "IN_GRACE_PERIOD",
  7: "PENDING_CLOSURE",
  8: "CLOSED",
  9: "ANY_ACTIVE",
  10: "ANY_CLOSED",
};

export interface AdAccount {
  id: string;             // act_XXXXXXXXX
  accountId: string;      // numeric string
  name: string;
  status: AccountStatus;
  statusCode: number;
  amountSpent: string;    // in cents as string
  currency: string;
  balance: string;        // in cents as string
  minDailyBudget: string;
}

interface RawAdAccount {
  id: string;
  name: string;
  account_id: string;
  account_status: number;
  amount_spent: string;
  currency: string;
  balance: string;
  min_daily_budget: string;
}

// ─── Fetch Ad Accounts ────────────────────────────────────────────────────────
export async function fetchAdAccounts(accessToken: string): Promise<AdAccount[]> {
  const cacheKey = `adaccounts:${accessToken.slice(-16)}`;
  const cached = cacheGet(adAccountsCache, cacheKey);
  if (cached) return cached;

  const appsecretProof = generateAppSecretProof(accessToken);

  let res;
  try {
    res = await axios.get<{ data: RawAdAccount[] }>(
      `${GRAPH}/me/adaccounts`,
      {
        params: {
          fields: "id,name,account_id,account_status,amount_spent,currency,balance,min_daily_budget",
          access_token: accessToken,
          appsecret_proof: appsecretProof,
          limit: 100,
        },
        timeout: 15000,
      }
    );
  } catch (err: unknown) {
    // Log the full Facebook API error for debugging
    if (axios.isAxiosError(err) && err.response) {
      console.error("[adAccountsService] Facebook API error:", JSON.stringify(err.response.data));
      throw new Error(`Facebook API ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }

  const accounts: AdAccount[] = (res.data.data ?? []).map((raw) => ({
    id: raw.id,
    accountId: raw.account_id,
    name: raw.name,
    status: STATUS_MAP[raw.account_status] ?? "UNKNOWN",
    statusCode: raw.account_status,
    amountSpent: raw.amount_spent ?? "0",
    currency: raw.currency ?? "USD",
    balance: raw.balance ?? "0",
    minDailyBudget: raw.min_daily_budget ?? "0",
  }));

  cacheSet(adAccountsCache, cacheKey, accounts);
  return accounts;
}

// ─── Types for Insights ───────────────────────────────────────────────────────
export interface DailyInsight {
  date: string;       // YYYY-MM-DD
  spend: number;      // USD float
  impressions: number;
  clicks: number;
  leads: number;
  cpl: number;        // cost per lead
  ctr: number;        // click-through rate %
}

export interface InsightsSummary {
  totalSpend: number;
  totalLeads: number;
  avgCpl: number;
  avgCtr: number;
  currency: string;
  daily: DailyInsight[];
}

interface RawInsightAction {
  action_type: string;
  value: string;
}

interface RawInsight {
  date_start: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: RawInsightAction[];
}

// ─── Fetch Insights ───────────────────────────────────────────────────────────
export async function fetchAdAccountInsights(
  adAccountId: string,
  accessToken: string,
  currency: string = "USD",
  datePreset: string = "last_30d"
): Promise<InsightsSummary> {
  const cacheKey = `insights:${adAccountId}:${datePreset}:${accessToken.slice(-16)}`;
  const cached = cacheGet(insightsCache, cacheKey);
  if (cached) {
    // Rebuild summary from cached daily data
    return buildSummary(cached, currency);
  }

  const appsecretProof = generateAppSecretProof(accessToken);

  const res = await axios.get<{ data: RawInsight[] }>(
    `${GRAPH}/${adAccountId}/insights`,
    {
      params: {
        fields: "date_start,spend,actions,impressions,clicks",
        time_increment: 1,
        date_preset: datePreset,
        action_breakdowns: "action_type",
        access_token: accessToken,
        appsecret_proof: appsecretProof,
        limit: 90,
      },
      timeout: 20000,
    }
  );

  const daily: DailyInsight[] = (res.data.data ?? []).map((raw) => {
    const spend = parseFloat(raw.spend ?? "0");
    const impressions = parseInt(raw.impressions ?? "0", 10);
    const clicks = parseInt(raw.clicks ?? "0", 10);

    // Extract lead count from actions array
    const leadAction = (raw.actions ?? []).find(
      (a) => a.action_type === "lead"
    );
    const leads = leadAction ? parseInt(leadAction.value, 10) : 0;

    const cpl = leads > 0 ? spend / leads : 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;

    return {
      date: raw.date_start,
      spend,
      impressions,
      clicks,
      leads,
      cpl: Math.round(cpl * 100) / 100,
      ctr: Math.round(ctr * 100) / 100,
    };
  });

  cacheSet(insightsCache, cacheKey, daily);
  return buildSummary(daily, currency);
}

function buildSummary(daily: DailyInsight[], currency: string): InsightsSummary {
  const totalSpend = daily.reduce((s, d) => s + d.spend, 0);
  const totalLeads = daily.reduce((s, d) => s + d.leads, 0);
  const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0;
  const avgCtr =
    daily.length > 0
      ? daily.reduce((s, d) => s + d.ctr, 0) / daily.length
      : 0;

  return {
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalLeads,
    avgCpl: Math.round(avgCpl * 100) / 100,
    avgCtr: Math.round(avgCtr * 100) / 100,
    currency,
    daily,
  };
}

// ─── Cache invalidation ───────────────────────────────────────────────────────
export function invalidateAdAccountsCache(accessToken: string): void {
  const cacheKey = `adaccounts:${accessToken.slice(-16)}`;
  adAccountsCache.delete(cacheKey);
}

export function invalidateInsightsCache(adAccountId: string, accessToken: string): void {
  const cacheKey = `insights:${adAccountId}:${accessToken.slice(-16)}`;
  insightsCache.delete(cacheKey);
}

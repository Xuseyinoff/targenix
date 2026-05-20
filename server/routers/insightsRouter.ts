/**
 * insightsRouter.ts
 *
 * Read-only API for the /insights surface. Every procedure reads from
 * `fact_attribution_daily` only — never from `leads`/`orders`/`campaign_insights`
 * directly — so the dashboard cannot accidentally slow down the
 * write-hot lead pipeline.
 *
 * Three procedures:
 *
 *   1. getOverview(start, end)
 *      Total KPIs over the date range, with delta vs. the prior equal-length
 *      period for the trend arrows on the KPI tiles.
 *
 *   2. getTimeSeries(start, end)
 *      Daily rows for the trend chart. Always returns one entry per day
 *      in the range (gaps backfilled with zeros) so the chart x-axis is
 *      contiguous.
 *
 *   3. getBreakdown(start, end, groupBy)
 *      Grouped rows for the table. `groupBy` selects the dimension:
 *      bm | adAccount | campaign | adset | ad | page | form | offer.
 *      Returns the top 200 rows ordered by leads DESC (UI can sort
 *      client-side); for finer granularity the user drills down by
 *      filtering, not by paginating thousands of rows.
 *
 * Multi-tenant safety: every WHERE filter starts with `userId = ctx.user.id`.
 * Defence in depth: the rollup writer also enforces user-scoped GROUP BYs,
 * so even a programming mistake here can't leak another tenant's slice.
 */

import { z } from "zod";
import { and, between, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  adAccounts,
  adSets,
  campaignInsights,
  campaigns,
  destinations,
  facebookForms,
  factAttributionDaily,
  integrations,
  leads,
  orders,
} from "../../drizzle/schema";
import { runInsightsRollupOnce } from "../services/insightsRollupScheduler";

// ── Input shape ──────────────────────────────────────────────────────────────
// YYYY-MM-DD strings to keep timezone semantics in the caller's hands. The
// server treats them as UTC (matching what the rollup worker writes).
const DateRange = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ── Group-by dimension whitelist ─────────────────────────────────────────────
// One entry per supported breakdown level. Mapped to the actual rollup column
// + a "label fallback" hint the client uses when rendering a row whose
// dimension value is '' (the unknown-sentinel from migration 0085).
const GROUP_BY_COLUMNS = {
  bm:        { col: factAttributionDaily.bmId,        emptyLabel: "(no BM)" },
  adAccount: { col: factAttributionDaily.adAccountId, emptyLabel: "(no ad account)" },
  campaign:  { col: factAttributionDaily.campaignId,  emptyLabel: "(no campaign)" },
  adset:     { col: factAttributionDaily.adsetId,     emptyLabel: "(no adset)" },
  ad:        { col: factAttributionDaily.adId,        emptyLabel: "(no ad)" },
  page:      { col: factAttributionDaily.pageId,      emptyLabel: "(no page)" },
  form:      { col: factAttributionDaily.formId,      emptyLabel: "(no form)" },
  offer:     { col: factAttributionDaily.offerId,     emptyLabel: "(no offer)" },
} as const;

type GroupByKey = keyof typeof GROUP_BY_COLUMNS;

// Helper: number of days between two YYYY-MM-DD strings, inclusive.
function daysBetween(start: string, end: string): number {
  const s = Date.parse(start + "T00:00:00Z");
  const e = Date.parse(end + "T00:00:00Z");
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}

// Helper: shift a YYYY-MM-DD string by N days, returning YYYY-MM-DD.
function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export const insightsRouter = router({
  // ── 1. Overview ──────────────────────────────────────────────────────────
  getOverview: protectedProcedure
    .input(DateRange)
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        return {
          current: emptyTotals(),
          previous: emptyTotals(),
          currency: "USD",
        };
      }

      // Currency is needed up-front: sumTotals's preset overlay converts
      // campaign_insights.spend (decimal-string in ad-account currency) into
      // baseCurrency's smallest unit, which depends on this value.
      const [u] = await db.execute(sql`
        SELECT baseCurrency FROM users WHERE id = ${userId}
      `);
      const currencyRow = ((u as unknown as { baseCurrency?: string }[])?.[0]) ?? { baseCurrency: "USD" };
      const currency = currencyRow.baseCurrency ?? "USD";

      const [current, previous] = await Promise.all([
        sumTotals(db, userId, input.start, input.end, currency),
        sumTotals(
          db,
          userId,
          shiftDate(input.start, -daysBetween(input.start, input.end)),
          shiftDate(input.start, -1),
          currency,
        ),
      ]);

      return { current, previous, currency };
    }),

  // ── 2. Time series ───────────────────────────────────────────────────────
  getTimeSeries: protectedProcedure
    .input(DateRange)
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return { series: [] as DailyRow[], currency: "USD" };

      const rows = await db
        .select({
          date: factAttributionDaily.date,
          leads: sql<number>`SUM(${factAttributionDaily.leads})`,
          sent: sql<number>`SUM(${factAttributionDaily.sent})`,
          delivered: sql<number>`SUM(${factAttributionDaily.delivered})`,
          revenue: sql<number>`SUM(${factAttributionDaily.revenueAmount})`,
          pipeline: sql<number>`SUM(${factAttributionDaily.pipelineAmount})`,
          spend: sql<number>`SUM(${factAttributionDaily.spendAmount})`,
        })
        .from(factAttributionDaily)
        .where(
          and(
            eq(factAttributionDaily.userId, userId),
            between(factAttributionDaily.date, input.start, input.end),
          ),
        )
        .groupBy(factAttributionDaily.date)
        .orderBy(factAttributionDaily.date);

      // Backfill missing days with zeros so the line chart is contiguous.
      const byDate = new Map<string, DailyRow>();
      for (const r of rows) {
        byDate.set(r.date, {
          date: r.date,
          leads: Number(r.leads) || 0,
          sent: Number(r.sent) || 0,
          delivered: Number(r.delivered) || 0,
          revenue: Number(r.revenue) || 0,
          spend: Number(r.spend) || 0,
          profit: (Number(r.revenue) || 0) - (Number(r.spend) || 0),
        });
      }

      const series: DailyRow[] = [];
      const n = daysBetween(input.start, input.end);
      for (let i = 0; i < n; i++) {
        const d = shiftDate(input.start, i);
        series.push(
          byDate.get(d) ?? {
            date: d, leads: 0, sent: 0, delivered: 0, revenue: 0, spend: 0, profit: 0,
          },
        );
      }

      const [u] = await db.execute(sql`SELECT baseCurrency FROM users WHERE id = ${userId}`);
      const currencyRow = ((u as unknown as { baseCurrency?: string }[])?.[0]) ?? { baseCurrency: "USD" };
      return { series, currency: currencyRow.baseCurrency ?? "USD" };
    }),

  // ── 3. Breakdown table ───────────────────────────────────────────────────
  getBreakdown: protectedProcedure
    .input(
      DateRange.extend({
        groupBy: z.enum([
          "bm", "adAccount", "campaign", "adset", "ad", "page", "form", "offer",
        ]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return { rows: [] as BreakdownRow[], currency: "USD" };

      const groupKey = input.groupBy as GroupByKey;
      const groupCol = GROUP_BY_COLUMNS[groupKey].col;

      const result = await db
        .select({
          key: groupCol,
          leads: sql<number>`SUM(${factAttributionDaily.leads})`,
          sent: sql<number>`SUM(${factAttributionDaily.sent})`,
          accepted: sql<number>`SUM(${factAttributionDaily.accepted})`,
          delivered: sql<number>`SUM(${factAttributionDaily.delivered})`,
          held: sql<number>`SUM(${factAttributionDaily.held})`,
          rejected: sql<number>`SUM(${factAttributionDaily.rejected})`,
          trash: sql<number>`SUM(${factAttributionDaily.trash})`,
          revenue: sql<number>`SUM(${factAttributionDaily.revenueAmount})`,
          pipeline: sql<number>`SUM(${factAttributionDaily.pipelineAmount})`,
          spend: sql<number>`SUM(${factAttributionDaily.spendAmount})`,
        })
        .from(factAttributionDaily)
        .where(
          and(
            eq(factAttributionDaily.userId, userId),
            between(factAttributionDaily.date, input.start, input.end),
          ),
        )
        .groupBy(groupCol)
        .orderBy(sql`SUM(${factAttributionDaily.leads}) DESC`)
        .limit(200);

      // Look up human-readable labels per dimension. Only the IDs that
      // appeared in the top-200 rows are queried — keeps the lookup
      // bounded regardless of total cardinality.
      const ids = result
        .map((r) => r.key ?? "")
        .filter((k) => k !== "");
      const labelMap = ids.length > 0
        ? await resolveLabels(db, userId, groupKey, ids)
        : new Map<string, string>();

      const rows: BreakdownRow[] = result.map((r) => {
        const leads = Number(r.leads) || 0;
        const sent = Number(r.sent) || 0;
        const delivered = Number(r.delivered) || 0;
        const revenue = Number(r.revenue) || 0;
        const spend = Number(r.spend) || 0;
        const key = r.key ?? "";
        // Order of precedence for the row label:
        //   1. Human name from the source table (campaigns.name, etc.)
        //   2. The ID itself when no name is known (fallback for newly-
        //      synced FB data that hasn't reached the source table yet,
        //      or for offerId where there is no source table)
        //   3. The dimension-specific "(no X)" sentinel for the empty key
        const label = key === "" ? GROUP_BY_COLUMNS[groupKey].emptyLabel : (labelMap.get(key) ?? key);
        return {
          key,
          label,
          leads,
          sent,
          accepted: Number(r.accepted) || 0,
          delivered,
          held: Number(r.held) || 0,
          rejected: Number(r.rejected) || 0,
          trash: Number(r.trash) || 0,
          revenue,
          pipeline: Number(r.pipeline) || 0,
          spend,
          profit: revenue - spend,
          deliveryRate: sent > 0 ? delivered / sent : 0,
        };
      });

      const [u] = await db.execute(sql`SELECT baseCurrency FROM users WHERE id = ${userId}`);
      const currencyRow = ((u as unknown as { baseCurrency?: string }[])?.[0]) ?? { baseCurrency: "USD" };
      return { rows, currency: currencyRow.baseCurrency ?? "USD" };
    }),

  // ── 4. Campaign drill-down: per-affiliate breakdown ──────────────────────
  // Departs from the rollup-only pattern used by the other procedures.
  // `fact_attribution_daily` has no appKey dimension, so we LIVE-JOIN
  // leads ⨯ orders ⨯ integrations ⨯ destinations for the single campaign
  // the user clicked. Bounded query: ONE campaign × N days = a few thousand
  // rows at most, fast enough without pre-aggregation.
  //
  // Three resultsets in one round-trip:
  //   1. campaign — name + totalLeads + totalSpend + totalRevenue (with
  //      "partial" flag when any affiliate has uncaptured payout)
  //   2. perAffiliate — counts per appKey + revenue (or null when the
  //      adapter doesn't capture payoutAmount yet, e.g. 100k.uz)
  //   3. statusDistribution — raw + canonical status counts for the
  //      "count strip" UI section
  //
  // Multi-tenant: every WHERE clause starts with `leads.userId = ctx.user.id`.
  getCampaignAffiliateBreakdown: protectedProcedure
    .input(
      DateRange.extend({
        campaignId: z.string().min(1).max(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        return emptyCampaignBreakdown(input.campaignId);
      }

      // Date range → inclusive UTC day boundaries. `leads.createdAt` is
      // TIMESTAMP — compare against the exact bounds so the upper limit
      // includes the whole `end` day.
      const startTs = new Date(input.start + "T00:00:00Z");
      const endTs = new Date(input.end + "T23:59:59.999Z");

      // 1) Campaign name + lead count + currency. campaignName lives on
      //    leads (denormalized from FB sync); we pick the freshest non-
      //    empty one as the label.
      const [campaignHeader] = await db
        .select({
          campaignName: sql<string>`COALESCE(MAX(NULLIF(${leads.campaignName}, '')), '')`,
          totalLeads: sql<number>`COUNT(*)`,
        })
        .from(leads)
        .where(
          and(
            eq(leads.userId, userId),
            eq(leads.campaignId, input.campaignId),
            sql`${leads.createdAt} BETWEEN ${startTs} AND ${endTs}`,
          ),
        );

      const [u] = await db.execute(sql`SELECT baseCurrency FROM users WHERE id = ${userId}`);
      const currency = ((u as unknown as { baseCurrency?: string }[])?.[0]?.baseCurrency) ?? "USD";

      // 2) Spend for this campaign over the range. Reads campaign_daily_insights
      //    (the same source the rollup writer uses); preset-overlay handling
      //    is deliberately omitted here because the drill-down is supposed to
      //    show the snapshot the rollup uses — adding the overlay would make
      //    the drill-down disagree with the parent row by a small delta on
      //    today/yesterday and is misleading for breakdown analysis.
      const spendResult = await db.execute(sql`
        SELECT
          COALESCE(SUM(CAST(cdi.spend AS DECIMAL(20,2))), 0) AS spendDecimal,
          MAX(aa.currency) AS spendCurrency
        FROM campaign_daily_insights cdi
        LEFT JOIN ad_accounts aa
          ON aa.userId = cdi.userId AND aa.fbAdAccountId = cdi.fbAdAccountId
        WHERE cdi.userId = ${userId}
          AND cdi.fbCampaignId = ${input.campaignId}
          AND cdi.date BETWEEN ${input.start} AND ${input.end}
      `);
      const spendList = ((spendResult as unknown as [Array<{
        spendDecimal: string | number;
        spendCurrency: string | null;
      }>, unknown])?.[0] ?? []) as Array<{
        spendDecimal: string | number;
        spendCurrency: string | null;
      }>;
      const spendDecimal = String(spendList[0]?.spendDecimal ?? "0");
      const spendCurrency = spendList[0]?.spendCurrency ?? currency;
      const totalSpendMinor = presetSpendToRollupUnit(spendDecimal, spendCurrency);

      // 3) Per-affiliate breakdown. Live JOIN leads → orders → integrations
      //    → destinations. Group by appKey + the destination name so two
      //    same-appKey destinations with different display names stay
      //    distinct (rare; multi-tenant safety net).
      const perAffiliateResult = await db.execute(sql`
        SELECT
          d.appKey AS appKey,
          MAX(d.name) AS affiliateName,
          COUNT(DISTINCT o.id) AS ordersSent,
          SUM(CASE WHEN o.crmStatus = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN o.crmStatus IS NOT NULL
                    AND o.isFinal = 0 THEN 1 ELSE 0 END) AS inFlight,
          SUM(CASE WHEN o.crmStatus IN ('cancelled','returned','not_sold')
                   THEN 1 ELSE 0 END) AS rejected,
          SUM(CASE WHEN o.crmStatus = 'archived' THEN 1 ELSE 0 END) AS archived,
          SUM(CASE WHEN o.crmStatus IS NULL THEN 1 ELSE 0 END) AS unsynced,
          COALESCE(SUM(CASE WHEN o.crmStatus = 'delivered'
                              AND o.payoutAmount IS NOT NULL
                            THEN o.payoutAmount ELSE 0 END), 0) AS revenueMinor,
          MAX(o.payoutCurrency) AS payoutCurrency,
          SUM(CASE WHEN o.payoutAmount IS NOT NULL THEN 1 ELSE 0 END) AS payoutCapturedCount
        FROM leads l
        INNER JOIN orders o ON o.leadId = l.id
        INNER JOIN integrations i ON i.id = o.integrationId
        INNER JOIN destinations d ON d.id = i.destinationId
        WHERE l.userId = ${userId}
          AND l.campaignId = ${input.campaignId}
          AND l.createdAt BETWEEN ${startTs} AND ${endTs}
        GROUP BY d.appKey
        ORDER BY ordersSent DESC
      `);

      const affiliateList = ((perAffiliateResult as unknown as [Array<{
        appKey: string;
        affiliateName: string | null;
        ordersSent: number | string;
        delivered: number | string;
        inFlight: number | string;
        rejected: number | string;
        archived: number | string;
        unsynced: number | string;
        revenueMinor: number | string;
        payoutCurrency: string | null;
        payoutCapturedCount: number | string;
      }>, unknown])?.[0] ?? []) as Array<{
        appKey: string;
        affiliateName: string | null;
        ordersSent: number | string;
        delivered: number | string;
        inFlight: number | string;
        rejected: number | string;
        archived: number | string;
        unsynced: number | string;
        revenueMinor: number | string;
        payoutCurrency: string | null;
        payoutCapturedCount: number | string;
      }>;

      let totalRevenueMinor = 0;
      let anyAffiliateMissingPayout = false;
      const perAffiliate = affiliateList.map((r) => {
        const delivered = Number(r.delivered) || 0;
        const payoutCapturedCount = Number(r.payoutCapturedCount) || 0;
        const revenueMinor = Number(r.revenueMinor) || 0;
        const revenueAvailable = delivered > 0 && payoutCapturedCount > 0;
        const syncStatus = classifyAffiliateSync(r.appKey);
        // Track partial-revenue: any affiliate with deliveries but no captured
        // payout means the campaign total is incomplete.
        if (delivered > 0 && payoutCapturedCount === 0) {
          anyAffiliateMissingPayout = true;
        }
        if (revenueAvailable) totalRevenueMinor += revenueMinor;
        return {
          appKey: r.appKey,
          affiliateName: r.affiliateName ?? r.appKey,
          ordersSent: Number(r.ordersSent) || 0,
          delivered,
          inFlight: Number(r.inFlight) || 0,
          rejected: Number(r.rejected) || 0,
          archived: Number(r.archived) || 0,
          unsynced: Number(r.unsynced) || 0,
          revenue: revenueAvailable
            ? {
                amountMinor: revenueMinor,
                currency: r.payoutCurrency ?? currency,
              }
            : null,
          revenueAvailable,
          syncStatus,
        };
      });

      // 4) Status distribution — flat list, sorted by count desc. Empty
      //    crmRawStatus is folded to '(unsynced)' so the UI strip shows a
      //    single labeled cell rather than a blank.
      const statusResult = await db.execute(sql`
        SELECT
          COALESCE(NULLIF(o.crmRawStatus, ''), '(unsynced)') AS crmRawStatus,
          COALESCE(NULLIF(o.crmStatus, ''),    '(unsynced)') AS crmStatus,
          COUNT(*) AS n
        FROM leads l
        INNER JOIN orders o ON o.leadId = l.id
        WHERE l.userId = ${userId}
          AND l.campaignId = ${input.campaignId}
          AND l.createdAt BETWEEN ${startTs} AND ${endTs}
        GROUP BY crmRawStatus, crmStatus
        ORDER BY n DESC
      `);
      const statusDistribution = (((statusResult as unknown as [Array<{
        crmRawStatus: string;
        crmStatus: string;
        n: number | string;
      }>, unknown])?.[0] ?? []) as Array<{
        crmRawStatus: string;
        crmStatus: string;
        n: number | string;
      }>).map((r) => ({
        crmRawStatus: r.crmRawStatus,
        crmStatus: r.crmStatus,
        count: Number(r.n) || 0,
      }));

      return {
        campaign: {
          id: input.campaignId,
          name: campaignHeader?.campaignName ?? "",
          totalLeads: Number(campaignHeader?.totalLeads) || 0,
          totalSpend: { amountMinor: totalSpendMinor, currency: spendCurrency },
          totalRevenue: { amountMinor: totalRevenueMinor, currency },
          totalRevenueNote: anyAffiliateMissingPayout ? ("partial" as const) : ("complete" as const),
        },
        perAffiliate,
        statusDistribution,
      };
    }),

  // ── 5. Admin: manual rollup trigger ──────────────────────────────────────
  // For diagnostics + on-demand recompute. The scheduler runs every 15 min
  // automatically; this lets an operator force a pass without waiting (e.g.
  // right after a deploy to refresh the table immediately).
  triggerRollup: adminProcedure.mutation(async () => {
    const startedAt = Date.now();
    await runInsightsRollupOnce();
    return { ok: true, durationMs: Date.now() - startedAt };
  }),
});

// Classify an affiliate's CRM-sync maturity. Drives the badge in the
// drill-down UI:
//   'live'    → CRM sync wired up AND payout captured (sotuvchi)
//   'pending' → CRM sync wired up but payout NOT captured (100k.uz —
//               Phase 3.1 follow-up)
//   'no-sync' → CRM sync not implemented for this platform (alijahon,
//               inbaza, mgoods)
// The list is explicit rather than dynamic — keeps the badge stable
// across deploys and is one place to update when a new platform comes
// online.
function classifyAffiliateSync(appKey: string): "live" | "pending" | "no-sync" {
  switch (appKey) {
    case "sotuvchi":
      return "live";
    case "100k":
      return "pending";
    case "alijahon":
    case "inbaza":
    case "mgoods":
      return "no-sync";
    default:
      return "no-sync";
  }
}

function emptyCampaignBreakdown(campaignId: string) {
  return {
    campaign: {
      id: campaignId,
      name: "",
      totalLeads: 0,
      totalSpend: { amountMinor: 0, currency: "USD" },
      totalRevenue: { amountMinor: 0, currency: "USD" },
      totalRevenueNote: "complete" as const,
    },
    perAffiliate: [] as Array<{
      appKey: string;
      affiliateName: string;
      ordersSent: number;
      delivered: number;
      inFlight: number;
      rejected: number;
      archived: number;
      unsynced: number;
      revenue: { amountMinor: number; currency: string } | null;
      revenueAvailable: boolean;
      syncStatus: "live" | "pending" | "no-sync";
    }>,
    statusDistribution: [] as Array<{
      crmRawStatus: string;
      crmStatus: string;
      count: number;
    }>,
  };
}

// ── Shared types + helpers ───────────────────────────────────────────────────

interface Totals {
  leads: number;
  sent: number;
  accepted: number;
  delivered: number;
  held: number;
  rejected: number;
  trash: number;
  revenue: number;
  /** In-flight money — sotuvchi has committed pay_for for an order whose
   *  crmStatus is past `new` but not yet `delivered`. Reported separately
   *  from `revenue`; intentionally NOT added to `profit`. */
  pipeline: number;
  spend: number;
  profit: number;
}

// Time-series intentionally returns a narrower row than Totals — the trend
// chart only graphs lead volume + money, not the per-CRM-bucket counters.
interface DailyRow {
  date: string;
  leads: number;
  sent: number;
  delivered: number;
  revenue: number;
  spend: number;
  profit: number;
}

interface BreakdownRow extends Totals {
  key: string;
  label: string;
  deliveryRate: number;
}

function emptyTotals(): Totals {
  return {
    leads: 0, sent: 0, accepted: 0, delivered: 0, held: 0,
    rejected: 0, trash: 0, revenue: 0, pipeline: 0, spend: 0, profit: 0,
  };
}

/**
 * For the given group-by dimension, return a Map<id, label> covering only
 * the IDs that showed up in this breakdown. One small targeted query per
 * dimension — no JOIN against the rollup itself.
 *
 * Lookup sources per dimension:
 *   bm         → ad_accounts.bmName (DISTINCT, MAX as tie-breaker)
 *   adAccount  → ad_accounts.name
 *   campaign   → campaigns.name
 *   adset      → ad_sets.name
 *   ad         → leads.adName (denormalized at lead-write time)
 *   page       → facebook_forms.pageName (sometimes also on leads)
 *   form       → facebook_forms.formName
 *   offer      → no name table; the ID is the label (sotuvchi offer IDs
 *                  are short numerics so this is fine for now)
 *
 * Every lookup is `userId`-scoped — defence in depth so a buggy caller
 * can never see another tenant's labels.
 */
async function resolveLabels(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  groupKey: GroupByKey,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  switch (groupKey) {
    case "bm": {
      // bmName lives on every ad_account row; one BM may appear on
      // multiple accounts so we MAX(bmName) for a deterministic value.
      const rows = await db
        .select({ id: adAccounts.bmId, name: sql<string>`MAX(${adAccounts.bmName})` })
        .from(adAccounts)
        .where(and(eq(adAccounts.userId, userId), inArray(adAccounts.bmId, ids)))
        .groupBy(adAccounts.bmId);
      for (const r of rows) if (r.id && r.name) out.set(r.id, r.name);
      return out;
    }
    case "adAccount": {
      const rows = await db
        .select({ id: adAccounts.fbAdAccountId, name: adAccounts.name })
        .from(adAccounts)
        .where(and(eq(adAccounts.userId, userId), inArray(adAccounts.fbAdAccountId, ids)));
      for (const r of rows) out.set(r.id, r.name);
      return out;
    }
    case "campaign": {
      const rows = await db
        .select({ id: campaigns.fbCampaignId, name: campaigns.name })
        .from(campaigns)
        .where(and(eq(campaigns.userId, userId), inArray(campaigns.fbCampaignId, ids)));
      for (const r of rows) out.set(r.id, r.name);
      return out;
    }
    case "adset": {
      const rows = await db
        .select({ id: adSets.fbAdSetId, name: adSets.name })
        .from(adSets)
        .where(and(eq(adSets.userId, userId), inArray(adSets.fbAdSetId, ids)));
      for (const r of rows) out.set(r.id, r.name);
      return out;
    }
    case "ad": {
      // No `ads` cache table; leads carry the denormalized adName from
      // Graph enrichment. MAX() picks one name per adId — names can drift
      // if FB renames an ad mid-flight, but the freshest write wins.
      const rows = await db.execute(sql`
        SELECT adId AS id, MAX(adName) AS name
          FROM leads
         WHERE userId = ${userId}
           AND adId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
         GROUP BY adId
      `);
      const list = ((rows as unknown as [Array<{ id: string; name: string }>, unknown])?.[0] ?? []) as Array<{ id: string; name: string }>;
      for (const r of list) if (r.id && r.name) out.set(r.id, r.name);
      return out;
    }
    case "page": {
      // facebook_forms is small — one row per (user, page, form) — and is
      // keyed cleanly by pageId.
      const rows = await db
        .selectDistinct({ id: facebookForms.pageId, name: facebookForms.pageName })
        .from(facebookForms)
        .where(and(eq(facebookForms.userId, userId), inArray(facebookForms.pageId, ids)));
      for (const r of rows) out.set(r.id, r.name);
      return out;
    }
    case "form": {
      const rows = await db
        .select({ id: facebookForms.formId, name: facebookForms.formName })
        .from(facebookForms)
        .where(and(eq(facebookForms.userId, userId), inArray(facebookForms.formId, ids)));
      for (const r of rows) out.set(r.id, r.name);
      return out;
    }
    case "offer": {
      // Offer names are denormalised onto `orders.offerName` by the
      // sotuvchi pagination sync (Phase 4 follow-up). Pick the most
      // recently synced label per offerId so renames propagate. Scoped
      // to userId for tenant isolation.
      const rows = await db
        .select({ id: orders.offerId, name: sql<string>`MAX(${orders.offerName})` })
        .from(orders)
        .where(
          and(
            eq(orders.userId, userId),
            inArray(orders.offerId, ids),
            isNotNull(orders.offerName),
          ),
        )
        .groupBy(orders.offerId);
      for (const r of rows) {
        if (r.id && r.name) out.set(r.id, r.name);
      }
      return out;
    }
  }
}

/**
 * Convert a decimal-currency-string from `campaign_insights.spend` (e.g.
 * "12.34" for USD, "100000.00" for UZS) into the same smallest-unit integer
 * the rollup stores in `fact_attribution_daily.spendAmount`.
 *
 * Matches the convention in adsSyncService.spendToSmallestUnit():
 *   USD / EUR / GBP → cents (multiply by 100).
 *   UZS / no-subunit → so'm (identity, rounded).
 */
function presetSpendToRollupUnit(decimalString: string, baseCurrency: string): number {
  const n = parseFloat(decimalString ?? "0");
  if (!Number.isFinite(n) || n < 0) return 0;
  if (baseCurrency === "USD" || baseCurrency === "EUR" || baseCurrency === "GBP") {
    return Math.round(n * 100);
  }
  return Math.round(n);
}

/**
 * Hybrid spend overlay for today/yesterday.
 *
 * FB Marketing API's `time_increment=1` daily breakdown lags the preset
 * aggregate by 24-48h while attribution settles — so `campaign_daily_insights`
 * (and therefore the rollup's `spendAmount`) shows $0 for the current day and
 * frequently the previous day too, even though `campaign_insights`
 * (preset=today/yesterday) is freshly synced every hour. Replace the rollup's
 * stale per-day spend with the preset value whenever today or yesterday falls
 * inside the requested range. Cross-currency case: we filter by the joined
 * ad_account.currency = baseCurrency, mirroring the rollup's same-currency-
 * only join, so a UZS ad account in a USD user's range stays excluded
 * consistently. Verified against samanhusanov11's "Today" view on 2026-05-15:
 * before the fix Insights showed Spend=$0 while Lead Cost Summary (same
 * source) showed $2,251 — after, both match.
 */
async function spendOverlayDelta(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  start: string,
  end: string,
  baseCurrency: string,
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = shiftDate(today, -1);

  const targets: Array<{ date: string; preset: "today" | "yesterday" }> = [];
  if (today >= start && today <= end) targets.push({ date: today, preset: "today" });
  if (yesterday >= start && yesterday <= end) targets.push({ date: yesterday, preset: "yesterday" });
  if (targets.length === 0) return 0;

  let delta = 0;
  for (const { date, preset } of targets) {
    const [rollupRow] = await db
      .select({
        spend: sql<number>`COALESCE(SUM(${factAttributionDaily.spendAmount}), 0)`,
      })
      .from(factAttributionDaily)
      .where(
        and(
          eq(factAttributionDaily.userId, userId),
          eq(factAttributionDaily.date, date),
          eq(factAttributionDaily.currency, baseCurrency),
        ),
      );

    const presetRows = await db.execute(sql`
      SELECT COALESCE(SUM(CAST(ci.spend AS DECIMAL(20,2))), 0) AS spend
      FROM campaign_insights ci
      INNER JOIN ad_accounts aa
        ON aa.userId = ci.userId AND aa.fbAdAccountId = ci.fbAdAccountId
      WHERE ci.userId = ${userId}
        AND ci.datePreset = ${preset}
        AND aa.currency = ${baseCurrency}
    `);
    const freshDecimal = String(
      (presetRows as unknown as Array<{ spend?: string | number }>)?.[0]?.spend ?? "0",
    );
    const freshUnits = presetSpendToRollupUnit(freshDecimal, baseCurrency);
    const staleUnits = Number(rollupRow?.spend) || 0;
    delta += freshUnits - staleUnits;
  }
  return delta;
}

async function sumTotals(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  start: string,
  end: string,
  baseCurrency: string,
): Promise<Totals> {
  if (daysBetween(start, end) === 0) return emptyTotals();
  const [rows, spendDelta] = await Promise.all([
    db
      .select({
        leads: sql<number>`COALESCE(SUM(${factAttributionDaily.leads}), 0)`,
        sent: sql<number>`COALESCE(SUM(${factAttributionDaily.sent}), 0)`,
        accepted: sql<number>`COALESCE(SUM(${factAttributionDaily.accepted}), 0)`,
        delivered: sql<number>`COALESCE(SUM(${factAttributionDaily.delivered}), 0)`,
        held: sql<number>`COALESCE(SUM(${factAttributionDaily.held}), 0)`,
        rejected: sql<number>`COALESCE(SUM(${factAttributionDaily.rejected}), 0)`,
        trash: sql<number>`COALESCE(SUM(${factAttributionDaily.trash}), 0)`,
        revenue: sql<number>`COALESCE(SUM(${factAttributionDaily.revenueAmount}), 0)`,
        pipeline: sql<number>`COALESCE(SUM(${factAttributionDaily.pipelineAmount}), 0)`,
        spend: sql<number>`COALESCE(SUM(${factAttributionDaily.spendAmount}), 0)`,
      })
      .from(factAttributionDaily)
      .where(
        and(
          eq(factAttributionDaily.userId, userId),
          between(factAttributionDaily.date, start, end),
        ),
      ),
    spendOverlayDelta(db, userId, start, end, baseCurrency),
  ]);
  const r = rows[0];
  const revenue = Number(r?.revenue) || 0;
  const spend = Math.max(0, (Number(r?.spend) || 0) + spendDelta);
  return {
    leads: Number(r?.leads) || 0,
    sent: Number(r?.sent) || 0,
    accepted: Number(r?.accepted) || 0,
    delivered: Number(r?.delivered) || 0,
    held: Number(r?.held) || 0,
    rejected: Number(r?.rejected) || 0,
    trash: Number(r?.trash) || 0,
    revenue,
    pipeline: Number(r?.pipeline) || 0,
    spend,
    profit: revenue - spend,
  };
}

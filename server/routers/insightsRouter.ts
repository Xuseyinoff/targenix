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
import { and, between, eq, inArray, sql } from "drizzle-orm";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  adAccounts,
  adSets,
  campaigns,
  facebookForms,
  factAttributionDaily,
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

      const [current, previous] = await Promise.all([
        sumTotals(db, userId, input.start, input.end),
        sumTotals(
          db,
          userId,
          shiftDate(input.start, -daysBetween(input.start, input.end)),
          shiftDate(input.start, -1),
        ),
      ]);

      // Pull the user's reporting currency. The rollup itself stamps the
      // currency on every row, but for an empty range we still want to show
      // a sensible currency label.
      const [u] = await db.execute(sql`
        SELECT baseCurrency FROM users WHERE id = ${userId}
      `);
      const currencyRow = ((u as unknown as { baseCurrency?: string }[])?.[0]) ?? { baseCurrency: "USD" };
      const currency = currencyRow.baseCurrency ?? "USD";

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
          spend,
          profit: revenue - spend,
          deliveryRate: sent > 0 ? delivered / sent : 0,
        };
      });

      const [u] = await db.execute(sql`SELECT baseCurrency FROM users WHERE id = ${userId}`);
      const currencyRow = ((u as unknown as { baseCurrency?: string }[])?.[0]) ?? { baseCurrency: "USD" };
      return { rows, currency: currencyRow.baseCurrency ?? "USD" };
    }),

  // ── 4. Admin: manual rollup trigger ──────────────────────────────────────
  // For diagnostics + on-demand recompute. The scheduler runs every 15 min
  // automatically; this lets an operator force a pass without waiting (e.g.
  // right after a deploy to refresh the table immediately).
  triggerRollup: adminProcedure.mutation(async () => {
    const startedAt = Date.now();
    await runInsightsRollupOnce();
    return { ok: true, durationMs: Date.now() - startedAt };
  }),
});

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
    rejected: 0, trash: 0, revenue: 0, spend: 0, profit: 0,
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
    case "offer":
      // No label table for offers in v1 — the ID is the label.
      return out;
  }
}

async function sumTotals(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  start: string,
  end: string,
): Promise<Totals> {
  if (daysBetween(start, end) === 0) return emptyTotals();
  const rows = await db
    .select({
      leads: sql<number>`COALESCE(SUM(${factAttributionDaily.leads}), 0)`,
      sent: sql<number>`COALESCE(SUM(${factAttributionDaily.sent}), 0)`,
      accepted: sql<number>`COALESCE(SUM(${factAttributionDaily.accepted}), 0)`,
      delivered: sql<number>`COALESCE(SUM(${factAttributionDaily.delivered}), 0)`,
      held: sql<number>`COALESCE(SUM(${factAttributionDaily.held}), 0)`,
      rejected: sql<number>`COALESCE(SUM(${factAttributionDaily.rejected}), 0)`,
      trash: sql<number>`COALESCE(SUM(${factAttributionDaily.trash}), 0)`,
      revenue: sql<number>`COALESCE(SUM(${factAttributionDaily.revenueAmount}), 0)`,
      spend: sql<number>`COALESCE(SUM(${factAttributionDaily.spendAmount}), 0)`,
    })
    .from(factAttributionDaily)
    .where(
      and(
        eq(factAttributionDaily.userId, userId),
        between(factAttributionDaily.date, start, end),
      ),
    );
  const r = rows[0];
  const revenue = Number(r?.revenue) || 0;
  const spend = Number(r?.spend) || 0;
  return {
    leads: Number(r?.leads) || 0,
    sent: Number(r?.sent) || 0,
    accepted: Number(r?.accepted) || 0,
    delivered: Number(r?.delivered) || 0,
    held: Number(r?.held) || 0,
    rejected: Number(r?.rejected) || 0,
    trash: Number(r?.trash) || 0,
    revenue,
    spend,
    profit: revenue - spend,
  };
}

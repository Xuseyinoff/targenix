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
import { and, between, eq, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { factAttributionDaily } from "../../drizzle/schema";

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

      const rows: BreakdownRow[] = result.map((r) => {
        const leads = Number(r.leads) || 0;
        const sent = Number(r.sent) || 0;
        const delivered = Number(r.delivered) || 0;
        const revenue = Number(r.revenue) || 0;
        const spend = Number(r.spend) || 0;
        return {
          key: r.key ?? "",
          label: r.key === "" || r.key == null ? GROUP_BY_COLUMNS[groupKey].emptyLabel : String(r.key),
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

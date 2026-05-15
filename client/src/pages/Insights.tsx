/**
 * Insights — Phase 1 Overview page.
 *
 * Single page that surfaces `fact_attribution_daily` to end users:
 *   • KPI tiles (Leads / Sent / Delivered / Revenue / Profit) with
 *     deltas vs. the prior equal-length period.
 *   • Daily trend chart — leads vs. revenue, dual-axis area.
 *   • Group-by table — pick any FB attribution dimension (BM, ad
 *     account, campaign, adset, ad, page, form) or offer; sortable
 *     locally.
 *
 * Reads from the `insights.*` tRPC namespace; no direct queries
 * against leads/orders. Refreshes are cheap because the rollup is
 * single-table, indexed, and small relative to source tables.
 *
 * Revenue + Spend formatting:
 *   - Server returns money in the smallest unit of the row's currency:
 *     UZS so'm (integer 1 = 1 so'm) / USD cents (integer 100 = $1.00).
 *   - Renderer below switches divisor + symbol on the `currency` field
 *     in the API response.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AreaChart, Area, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Legend,
} from "recharts";
import { ArrowDown, ArrowUp, BarChart3, Loader2 } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

// ── Date range presets (kept local — small enough not to need a util) ────────
type PresetKey = "today" | "yesterday" | "last_7d" | "last_30d";

function rangeFor(preset: PresetKey): { start: string; end: string; label: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dayShift = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  switch (preset) {
    case "today":     return { start: todayStr,    end: todayStr,    label: "Today" };
    case "yesterday": return { start: dayShift(1), end: dayShift(1), label: "Yesterday" };
    case "last_7d":   return { start: dayShift(6), end: todayStr,    label: "Last 7 days" };
    case "last_30d":  return { start: dayShift(29), end: todayStr,   label: "Last 30 days" };
  }
}

// ── Money formatter — switches on the API-reported currency. ────────────────
function formatMoney(amount: number, currency: string): string {
  if (currency === "UZS") {
    // 1 unit = 1 so'm; show as "1,234,500 UZS" with thin separators.
    return `${Math.round(amount).toLocaleString("en-US")} UZS`;
  }
  // Default USD → 100 units = $1.00; never trust other currencies in v1.
  return `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

type GroupByKey = "bm" | "adAccount" | "campaign" | "adset" | "ad" | "page" | "form" | "offer";

const GROUP_BY_LABELS: Record<GroupByKey, string> = {
  bm: "Business Manager",
  adAccount: "Ad account",
  campaign: "Campaign",
  adset: "Ad set",
  ad: "Ad",
  page: "Page",
  form: "Form",
  offer: "Offer",
};

export default function Insights() {
  const [preset, setPreset] = useState<PresetKey>("last_7d");
  const [groupBy, setGroupBy] = useState<GroupByKey>("campaign");
  const range = useMemo(() => rangeFor(preset), [preset]);

  const overview = trpc.insights.getOverview.useQuery(
    { start: range.start, end: range.end },
    { staleTime: 60_000 },
  );
  const timeSeries = trpc.insights.getTimeSeries.useQuery(
    { start: range.start, end: range.end },
    { staleTime: 60_000 },
  );
  const breakdown = trpc.insights.getBreakdown.useQuery(
    { start: range.start, end: range.end, groupBy },
    { staleTime: 60_000 },
  );

  const currency = overview.data?.currency ?? "USD";
  const cur = overview.data?.current;
  const prev = overview.data?.previous;

  return (
    <DashboardLayout>
      <div className="space-y-4 p-4 lg:p-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <BarChart3 className="h-6 w-6" />
              Insights
            </h1>
            <p className="text-sm text-muted-foreground">
              {range.label} · {range.start} → {range.end} · {currency}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            {(["today", "yesterday", "last_7d", "last_30d"] as const).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={p === preset ? "default" : "outline"}
                onClick={() => setPreset(p)}
              >
                {rangeFor(p).label}
              </Button>
            ))}
          </div>
        </div>

        {/* KPI strip — 6 tiles incl. CPL (derived from spend + leads) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiTile
            label="Leads"
            value={cur ? formatNumber(cur.leads) : "—"}
            delta={cur && prev ? deltaPct(cur.leads, prev.leads) : null}
            loading={overview.isLoading}
          />
          <KpiTile
            label="Delivered"
            value={cur ? formatNumber(cur.delivered) : "—"}
            delta={cur && prev ? deltaPct(cur.delivered, prev.delivered) : null}
            loading={overview.isLoading}
          />
          <KpiTile
            label="Spend"
            value={cur ? formatMoney(cur.spend, currency) : "—"}
            delta={cur && prev ? deltaPct(cur.spend, prev.spend) : null}
            loading={overview.isLoading}
          />
          <KpiTile
            label="Revenue"
            value={cur ? formatMoney(cur.revenue, currency) : "—"}
            delta={cur && prev ? deltaPct(cur.revenue, prev.revenue) : null}
            loading={overview.isLoading}
          />
          <KpiTile
            label="CPL"
            value={cur && cur.leads > 0 ? formatMoney(cur.spend / cur.leads, currency) : "—"}
            delta={
              cur && prev && cur.leads > 0 && prev.leads > 0
                ? deltaPct(cur.spend / cur.leads, prev.spend / prev.leads)
                : null
            }
            loading={overview.isLoading}
          />
          <KpiTile
            label="Profit"
            value={cur ? formatMoney(cur.profit, currency) : "—"}
            delta={cur && prev ? deltaPct(cur.profit, prev.profit) : null}
            loading={overview.isLoading}
            valueClass={
              cur && cur.profit < 0
                ? "text-red-600 dark:text-red-400"
                : cur && cur.profit > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : undefined
            }
          />
        </div>

        {/* Trend chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              {timeSeries.isLoading ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeSeries.data?.series ?? []}>
                    <defs>
                      <linearGradient id="leadsArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="revenueArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(v: number, name: string) => {
                        if (name === "Revenue" || name === "Profit") return formatMoney(Number(v), currency);
                        return formatNumber(Number(v));
                      }}
                    />
                    <Legend />
                    <Area
                      yAxisId="left"
                      type="monotone"
                      dataKey="leads"
                      name="Leads"
                      stroke="#3b82f6"
                      fill="url(#leadsArea)"
                      strokeWidth={2}
                    />
                    <Area
                      yAxisId="right"
                      type="monotone"
                      dataKey="revenue"
                      name="Revenue"
                      stroke="#10b981"
                      fill="url(#revenueArea)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Breakdown table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Breakdown</CardTitle>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupByKey)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(GROUP_BY_LABELS) as GroupByKey[]).map((k) => (
                  <SelectItem key={k} value={k}>{GROUP_BY_LABELS[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            {breakdown.isLoading ? (
              <div className="flex h-32 items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : breakdown.data?.rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No data in this date range yet. The rollup worker refreshes every 15 minutes — give it a tick.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr className="border-b">
                      <th className="text-left py-2 pr-3">{GROUP_BY_LABELS[groupBy]}</th>
                      <th className="text-right py-2 px-3">Leads</th>
                      <th className="text-right py-2 px-3">Delivered</th>
                      <th className="text-right py-2 px-3">CPL</th>
                      <th className="text-right py-2 px-3">Spend</th>
                      <th className="text-right py-2 px-3">Revenue</th>
                      <th className="text-right py-2 px-3">ROAS</th>
                      <th className="text-right py-2 px-3">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(breakdown.data?.rows ?? []).map((r) => {
                      // Derived metrics. Each is undefined when its
                      // denominator is 0; the table renders "—" in that case.
                      const cpl = r.leads > 0 ? r.spend / r.leads : null;
                      const roas = r.spend > 0 ? r.revenue / r.spend : null;
                      return (
                        <tr key={r.key} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="py-2 pr-3 max-w-[280px] truncate" title={r.label}>{r.label}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(r.leads)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(r.delivered)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{cpl !== null ? formatMoney(cpl, currency) : "—"}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatMoney(r.spend, currency)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatMoney(r.revenue, currency)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">
                            {roas !== null ? `${roas.toFixed(2)}×` : "—"}
                          </td>
                          <td className={
                            "text-right py-2 px-3 tabular-nums " +
                            (r.profit < 0 ? "text-red-600 dark:text-red-400" : r.profit > 0 ? "text-emerald-600 dark:text-emerald-400" : "")
                          }>
                            {formatMoney(r.profit, currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

// ── KPI tile ────────────────────────────────────────────────────────────────
function KpiTile({
  label,
  value,
  delta,
  loading,
  valueClass,
}: {
  label: string;
  value: string;
  delta: number | null;
  loading: boolean;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={"mt-1 text-2xl font-semibold tabular-nums " + (valueClass ?? "")}>
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : value}
        </div>
        {delta !== null && !loading && (
          <div className={
            "mt-1 inline-flex items-center gap-0.5 text-xs " +
            (delta > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : delta < 0
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground")
          }>
            {delta > 0 ? <ArrowUp className="h-3 w-3" /> : delta < 0 ? <ArrowDown className="h-3 w-3" /> : null}
            {Math.abs(delta).toFixed(1)}%
            <span className="text-muted-foreground ml-1">vs prev</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

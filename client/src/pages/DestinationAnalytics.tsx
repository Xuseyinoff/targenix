/**
 * Destination Performance Analytics
 *
 * Shows per-destination delivery stats: today / 7d / 30d counts, success rates,
 * top-8 stacked bar chart, type filter, and per-destination time-series drill-down.
 */

import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  RefreshCw,
  Send,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type DestStat = {
  destinationId: number;
  name: string;
  type: "custom" | "template";
  color: string;
  isActive: boolean;
  today:   { total: number; success: number; failed: number };
  last7d:  { total: number; success: number; failed: number };
  last30d: { total: number; success: number; failed: number };
  successRate: number | null;
};

type FilterType = "all" | "custom" | "template";
type DrillRange = "today" | "last_7d" | "last_30d";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rateColor(rate: number | null): string {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 90) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 70) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function rateBg(rate: number | null): string {
  if (rate === null) return "bg-muted";
  if (rate >= 90) return "bg-emerald-500";
  if (rate >= 70) return "bg-amber-500";
  return "bg-red-500";
}

function TypeBadge({ type }: { type: "custom" | "template" }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
        type === "template"
          ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
          : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
      }`}
    >
      {type}
    </span>
  );
}

// ─── Custom chart tooltip ─────────────────────────────────────────────────────

function ChartTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-background shadow-md px-3 py-2 text-xs space-y-1 min-w-[120px]">
      <p className="font-medium text-muted-foreground">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 justify-between">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="capitalize text-muted-foreground">{p.name}</span>
          </div>
          <span className="font-bold">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Summary KPI card ─────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  sub,
  icon: Icon,
  iconClass,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  iconClass: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${iconClass}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <p className="text-3xl font-bold tracking-tight tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Drill-down time series ───────────────────────────────────────────────────

function DrillDown({
  destinationId,
  name,
}: {
  destinationId: number;
  name: string;
}) {
  const [range, setRange] = useState<DrillRange>("last_7d");
  const { data, isLoading } = trpc.targetWebsites.getDestinationTimeSeries.useQuery(
    { destinationId, range },
    { refetchInterval: 60_000 },
  );

  const points = data?.points ?? [];
  const hasData = points.some((p) => p.total > 0);
  const xTickInterval = range === "today" ? 3 : range === "last_7d" ? 0 : 4;

  return (
    <div className="mt-4 pt-4 border-t">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {name} — Time Series
        </p>
        <div className="flex rounded-full border bg-muted/50 p-0.5 gap-0.5">
          {(["today", "last_7d", "last_30d"] as DrillRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`text-[11px] px-2.5 py-0.5 rounded-full transition-all ${
                range === r
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r === "today" ? "Today" : r === "last_7d" ? "7d" : "30d"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-28 flex items-center justify-center">
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <div className="h-28 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">No delivery data for this period</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={110}>
          <AreaChart data={points} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id={`gs${destinationId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#10b981" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`gf${destinationId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.4} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              interval={xTickInterval}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip content={<ChartTip />} />
            <Area type="monotone" dataKey="sent"   name="sent"   stroke="#10b981" strokeWidth={1.5} fill={`url(#gs${destinationId})`} dot={false} />
            <Area type="monotone" dataKey="failed" name="failed" stroke="#ef4444" strokeWidth={1.5} fill={`url(#gf${destinationId})`} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ─── Destination Card ─────────────────────────────────────────────────────────

function DestinationCard({ dest }: { dest: DestStat }) {
  const [expanded, setExpanded] = useState(false);
  const rate = dest.successRate;

  return (
    <Card
      className={`transition-shadow hover:shadow-md cursor-pointer ${!dest.isActive ? "opacity-60" : ""}`}
      onClick={() => setExpanded((v) => !v)}
    >
      <CardContent className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-background"
              style={{ background: dest.color ?? "#6366f1" }}
            />
            <p className="text-sm font-semibold truncate" title={dest.name}>{dest.name}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <TypeBadge type={dest.type} />
            {expanded
              ? <ChevronUp   className="h-3.5 w-3.5 text-muted-foreground" />
              : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            }
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {([
            { label: "Today", data: dest.today },
            { label: "7 days", data: dest.last7d },
            { label: "30 days", data: dest.last30d },
          ] as const).map(({ label, data }) => (
            <div key={label} className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
              <p className="text-lg font-bold tabular-nums leading-none">{data.total}</p>
              <p className="text-[11px] mt-1.5 space-x-0.5">
                <span className="text-emerald-600">✓{data.success}</span>
                {" "}
                <span className="text-red-500">✗{data.failed}</span>
              </p>
            </div>
          ))}
        </div>

        {/* Success rate bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-muted-foreground">Success rate (30d)</p>
            <p className={`text-xs font-bold tabular-nums ${rateColor(rate)}`}>
              {rate !== null ? `${rate}%` : "—"}
            </p>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${rateBg(rate)}`}
              style={{ width: `${rate ?? 0}%` }}
            />
          </div>
        </div>

        {/* Drill-down chart */}
        {expanded && (
          <DrillDown
            destinationId={dest.destinationId}
            name={dest.name}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DestinationAnalytics() {
  const [filter, setFilter] = useState<FilterType>("all");

  const { data: destinations = [], isLoading, refetch } = trpc.targetWebsites.getDestinationStats.useQuery(
    undefined,
    { refetchInterval: 60_000 },
  );

  // Summary KPIs
  const totalDestinations = destinations.length;
  const total7d     = destinations.reduce((s, d) => s + d.last7d.total, 0);
  const total30d    = destinations.reduce((s, d) => s + d.last30d.total, 0);
  const success30d  = destinations.reduce((s, d) => s + d.last30d.success, 0);
  const overallRate = total30d > 0 ? Math.round((success30d / total30d) * 100) : null;

  // Bar chart data: sort by 7d total desc, keep top 8, collapse rest as "Others"
  const sorted = [...destinations].sort((a, b) => b.last7d.total - a.last7d.total);
  const top8   = sorted.slice(0, 8);
  const others = sorted.slice(8);
  const othersTotal   = others.reduce((s, d) => s + d.last7d.total,   0);
  const othersSuccess = others.reduce((s, d) => s + d.last7d.success, 0);
  const othersFailed  = others.reduce((s, d) => s + d.last7d.failed,  0);

  const barData = [
    ...top8.map((d) => ({
      name:    d.name.length > 22 ? d.name.slice(0, 20) + "…" : d.name,
      success: d.last7d.success,
      failed:  d.last7d.failed,
    })),
    ...(othersTotal > 0
      ? [{ name: `Others (${others.length})`, success: othersSuccess, failed: othersFailed }]
      : []),
  ].reverse(); // Recharts vertical layout renders bottom-to-top, reverse for top-to-bottom visual

  const chartHeight = Math.max((barData.length * 38) + 16, 120);

  // Filtered cards
  const filtered = destinations.filter((d) => filter === "all" || d.type === filter);

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-7xl">

        {/* ── Header ── */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Destination Performance</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Delivery success rates and lead volume per destination · last 30 days
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg border hover:border-border"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* ── Summary KPIs ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard
            label="Destinations"
            value={totalDestinations}
            sub="total configured"
            icon={Target}
            iconClass="bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
          />
          <SummaryCard
            label="Leads (7d)"
            value={total7d.toLocaleString()}
            sub="total deliveries"
            icon={Zap}
            iconClass="bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
          />
          <SummaryCard
            label="Leads (30d)"
            value={total30d.toLocaleString()}
            sub="total deliveries"
            icon={TrendingUp}
            iconClass="bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400"
          />
          <SummaryCard
            label="Success Rate (30d)"
            value={overallRate !== null ? `${overallRate}%` : "—"}
            sub={`${success30d.toLocaleString()} sent of ${total30d.toLocaleString()}`}
            icon={Send}
            iconClass={
              overallRate === null ? "bg-muted text-muted-foreground" :
              overallRate >= 90    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400" :
              overallRate >= 70    ? "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400" :
                                     "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"
            }
          />
        </div>

        {/* ── Stacked bar chart ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">Volume by Destination</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Top {Math.min(8, destinations.length)} destinations — last 7 days
                </p>
              </div>
              <div className="flex items-center gap-3">
                {[
                  { color: "#10b981", label: "Sent" },
                  { color: "#ef4444", label: "Failed" },
                ].map((l) => (
                  <div key={l.label} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: l.color }} />
                    <span className="text-xs text-muted-foreground">{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center h-40">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : barData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 gap-2">
                <Globe className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No delivery data in the last 7 days</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={chartHeight}>
                <BarChart
                  data={barData}
                  layout="vertical"
                  margin={{ top: 0, right: 32, left: 0, bottom: 0 }}
                  barSize={16}
                >
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={140}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.4} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
                  <Bar dataKey="success" name="sent"   stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="failed"  name="failed" stackId="a" fill="#ef4444" radius={[0, 3, 3, 0]}
                    label={{
                      position: "right",
                      fontSize: 11,
                      fill: "hsl(var(--muted-foreground))",
                      formatter: (_: unknown, entry: { payload?: { success?: number; failed?: number } }) => {
                        const t = (entry?.payload?.success ?? 0) + (entry?.payload?.failed ?? 0);
                        return t > 0 ? t : "";
                      },
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* ── Filter + Cards ── */}
        <div>
          {/* Filter tabs */}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div className="flex items-center gap-1 rounded-lg border p-1 bg-muted/30">
              {(["all", "custom", "template"] as FilterType[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    filter === f
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f === "all" ? "All" : f === "custom" ? "Custom" : "Template"}
                  <span className="ml-1.5 tabular-nums text-[10px] opacity-60">
                    {f === "all"
                      ? destinations.length
                      : destinations.filter((d) => d.type === f).length}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Click a card to see time series
            </p>
          </div>

          {/* Cards grid */}
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="animate-pulse">
                  <CardContent className="p-5 h-48" />
                </Card>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Globe className="h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                {destinations.length === 0
                  ? "No destinations configured yet."
                  : `No ${filter} destinations found.`}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((dest) => (
                <DestinationCard key={dest.destinationId} dest={dest} />
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground/50 pb-2">
          Success = SENT orders · Failed = FAILED orders · Pending orders excluded · Tashkent timezone (UTC+5)
        </p>
      </div>
    </DashboardLayout>
  );
}

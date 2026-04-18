import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  DollarSign,
  Info,
  Minus,
  Plug,
  Plus,
  Send,
  TrendingUp,
  Webhook,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import type { LeadPipelineFields } from "@/lib/leadPipelineBadgeModel";
import { LeadPipelineBadge } from "@/components/leads/PipelineBadges";
import { useT } from "@/hooks/useT";
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCplColor(cpl: number): string {
  if (cpl < 0.35) return "text-emerald-600";
  if (cpl < 0.43) return "text-amber-600";
  return "text-red-600";
}

function trendIcon(pct: number | null) {
  if (pct === null) return <Minus className="h-3 w-3 text-muted-foreground" />;
  if (pct > 0) return <ArrowUp className="h-3 w-3 text-emerald-500" />;
  if (pct < 0) return <ArrowDown className="h-3 w-3 text-red-500" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

function trendLabel(pct: number | null): string {
  if (pct === null) return "—";
  if (pct === 0) return "0%";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function trendClass(pct: number | null, positive = true): string {
  if (pct === null || pct === 0) return "text-muted-foreground";
  const good = positive ? pct > 0 : pct < 0;
  return good ? "text-emerald-600" : "text-red-500";
}

type RangeOption = "today" | "last_7d" | "last_30d";
const RANGE_LABELS: Record<RangeOption, string> = { today: "Today", last_7d: "7d", last_30d: "30d" };

function RangeTabs({ value, onChange }: { value: RangeOption; onChange: (r: RangeOption) => void }) {
  return (
    <div className="flex rounded-full border bg-muted/50 p-0.5 gap-0.5">
      {(["today", "last_7d", "last_30d"] as RangeOption[]).map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`text-xs px-3 py-1 rounded-full transition-all duration-150 ${
            value === r
              ? "bg-background text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  trendPct,
  trendPositive = true,
  icon: Icon,
  iconClass,
  sub,
}: {
  title: string;
  value: number | string;
  trendPct?: number | null;
  trendPositive?: boolean;
  icon: React.ElementType;
  iconClass: string;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
          <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${iconClass}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <p className="text-3xl font-bold tracking-tight tabular-nums">{value}</p>
        {trendPct !== undefined && (
          <div className="mt-2 flex items-center gap-1.5">
            {trendPct !== null ? (
              <>
                {trendIcon(trendPct)}
                <span className={`text-xs font-medium ${trendClass(trendPct, trendPositive)}`}>
                  {trendLabel(trendPct)}
                </span>
                <span className="text-xs text-muted-foreground">{sub ?? "vs yesterday"}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{sub ?? "no trend data"}</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Custom chart tooltip ─────────────────────────────────────────────────────

function ChartTooltipContent({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-background shadow-md px-3 py-2 text-xs space-y-1">
      <p className="font-medium text-muted-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground capitalize">{p.name}</span>
          <span className="font-bold ml-auto pl-4">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Home() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === "admin";
  const fastOpts = { refetchInterval: 5_000 };

  const { data: stats, isLoading } = trpc.leads.stats.useQuery(undefined, fastOpts);
  const { data: webhookStats } = trpc.webhook.stats.useQuery(undefined, { ...fastOpts, enabled: isAdmin });
  const { data: integrationsList } = trpc.integrations.list.useQuery(undefined, fastOpts);
  const { data: leadsData } = trpc.leads.list.useQuery({ limit: 5, offset: 0 }, fastOpts);

  const [chartRange, setChartRange] = useState<RangeOption>("last_7d");
  const [sourcesRange, setSourcesRange] = useState<RangeOption>("last_7d");
  const [leadCostRange, setLeadCostRange] = useState<"today" | "yesterday" | "last_7d" | "last_30d">("today");
  const [showAllCampaigns, setShowAllCampaigns] = useState(false);

  const { data: timeSeries } = trpc.leads.getTimeSeries.useQuery(
    { range: chartRange },
    { refetchInterval: 30_000 },
  );
  const { data: topSources } = trpc.leads.getTopSources.useQuery(
    { range: sourcesRange },
    { refetchInterval: 60_000 },
  );
  const { data: deliveryStats } = trpc.leads.getDeliveryStats.useQuery(
    { range: sourcesRange },
    { refetchInterval: 60_000 },
  );
  const { data: leadCostData, isLoading: leadCostLoading } = trpc.adAnalytics.getLeadCostSummary.useQuery(
    { dateRange: leadCostRange },
    { enabled: isAdmin, refetchInterval: 60_000 },
  );

  const activeIntegrations = integrationsList?.filter((i) => i.isActive).length ?? 0;

  // Trends: compare yesterday (full day) vs day-before-yesterday (full day).
  // Never compare today (partial) vs yesterday (full) — that causes misleading -98% at 8am.
  const ts7d = timeSeries?.range === "last_7d" ? timeSeries.points : null;
  const yesterdayPoint  = ts7d?.at(-2); // yesterday — full completed day
  const dayBeforePoint  = ts7d?.at(-3); // day before yesterday — full completed day
  function calcTrend(yestVal?: number, prevVal?: number): number | null {
    if (yestVal == null || prevVal == null || prevVal === 0) return null;
    return Math.round(((yestVal - prevVal) / prevVal) * 100);
  }
  const leadTrend   = calcTrend(yesterdayPoint?.total,  dayBeforePoint?.total);
  const sentTrend   = calcTrend(yesterdayPoint?.sent,   dayBeforePoint?.sent);
  const failedTrend = calcTrend(yesterdayPoint?.failed, dayBeforePoint?.failed);

  // Funnel data from all-time stats
  const totalLeads = stats?.leads.total ?? 0;
  const delivered = stats?.leads.received ?? 0;
  const pending = stats?.leads.pending ?? 0;
  const failed = stats?.leads.failed ?? 0;
  const attempted = delivered + failed; // pending = not yet attempted

  // X-axis tick interval for area chart
  const chartPoints = timeSeries?.points ?? [];
  const xTickInterval = chartRange === "today" ? 3 : chartRange === "last_7d" ? 0 : 4;

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-7xl">
        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("home.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("home.subtitle")}</p>
        </div>

        {/* ── KPI Strip ── */}
        {/* "Today's Leads" reads from leads table (same source as chart) — not orders.
            This keeps KPIs and chart consistent regardless of integration activity.
            Trend compares yesterday vs day-before (both full days) — never partial today. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard
            title="Leads Today"
            value={isLoading ? "—" : (stats?.leads.todayReceived ?? 0)}
            trendPct={chartRange === "last_7d" ? leadTrend : undefined}
            sub="yesterday vs day before"
            icon={Zap}
            iconClass="bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
          />
          <KpiCard
            title="Sent Today"
            value={isLoading ? "—" : (stats?.orders.sentToday ?? 0)}
            trendPct={chartRange === "last_7d" ? sentTrend : undefined}
            sub="yesterday vs day before"
            icon={Send}
            iconClass="bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
          />
          <KpiCard
            title="Failed Today"
            value={isLoading ? "—" : (stats?.todayIntegrationLeads?.leadsWithFailedDeliveryToday ?? 0)}
            trendPct={chartRange === "last_7d" ? failedTrend : undefined}
            trendPositive={false}
            sub="yesterday vs day before"
            icon={AlertTriangle}
            iconClass="bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"
          />
          <KpiCard
            title="All-time Sent"
            value={isLoading ? "—" : (stats?.orders.sent ?? 0)}
            icon={TrendingUp}
            iconClass="bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
          />
          <KpiCard
            title="Active Integrations"
            value={activeIntegrations}
            icon={Plug}
            iconClass="bg-primary/10 text-primary"
          />
        </div>

        {/* ── Time-Series Chart ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-base font-semibold">Leads Over Time</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {chartRange === "today" ? "Hourly breakdown" : `Daily totals — last ${chartRange === "last_7d" ? "7" : "30"} days`}
                </p>
              </div>
              <RangeTabs value={chartRange} onChange={(r) => setChartRange(r)} />
            </div>
          </CardHeader>
          <CardContent>
            {chartPoints.length === 0 ? (
              <div className="h-48 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">No data for this period</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartPoints} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradSent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    interval={xTickInterval}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="total" name="leads" stroke="#6366f1" strokeWidth={2} fill="url(#gradTotal)" dot={false} />
                  <Area type="monotone" dataKey="sent" name="sent" stroke="#10b981" strokeWidth={1.5} fill="url(#gradSent)" dot={false} strokeDasharray="0" />
                  <Area type="monotone" dataKey="failed" name="failed" stroke="#ef4444" strokeWidth={1.5} fill="url(#gradFailed)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
            <div className="flex items-center gap-4 mt-2 justify-end">
              {[
                { color: "#6366f1", label: "Leads" },
                { color: "#10b981", label: "Sent" },
                { color: "#ef4444", label: "Failed" },
              ].map((l) => (
                <div key={l.label} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
                  <span className="text-xs text-muted-foreground">{l.label}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ── Sources + Delivery ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top Sources */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-base font-semibold">Top Sources</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">Lead volume by form</p>
                </div>
                <RangeTabs value={sourcesRange} onChange={(r) => setSourcesRange(r)} />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {!topSources?.length ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <Zap className="h-7 w-7 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No source data</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(topSources.length * 36, 120)}>
                  <BarChart
                    data={topSources}
                    layout="vertical"
                    margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
                    barSize={12}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={120}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="sent" name="sent" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="failed" name="failed" stackId="a" fill="#ef4444" radius={[2, 2, 2, 2]} label={{ position: "right", fontSize: 11, fill: "hsl(var(--muted-foreground))", formatter: (_: unknown, entry: { payload?: { total?: number } }) => entry?.payload?.total ?? "" }} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Delivery Performance */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">Delivery Performance</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">Success rate per integration</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {!deliveryStats?.length ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <Plug className="h-7 w-7 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No delivery data</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {deliveryStats.map((d) => (
                    <div key={d.integrationId}>
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-sm font-medium truncate max-w-[200px]" title={d.name}>{d.name}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground tabular-nums">{d.sent}/{d.total}</span>
                          <span className={`text-xs font-bold tabular-nums ${d.successRate >= 90 ? "text-emerald-600" : d.successRate >= 70 ? "text-amber-600" : "text-red-500"}`}>
                            {d.successRate}%
                          </span>
                        </div>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${d.successRate >= 90 ? "bg-emerald-500" : d.successRate >= 70 ? "bg-amber-500" : "bg-red-500"}`}
                          style={{ width: `${d.successRate}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Pipeline Funnel ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Lead Pipeline</CardTitle>
            <p className="text-xs text-muted-foreground">All-time conversion funnel</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "Total Leads", value: totalLeads, color: "bg-indigo-500", pct: 100 },
                { label: "Attempted", value: attempted, color: "bg-blue-500", pct: totalLeads > 0 ? Math.round((attempted / totalLeads) * 100) : 0 },
                { label: "Delivered", value: delivered, color: "bg-emerald-500", pct: totalLeads > 0 ? Math.round((delivered / totalLeads) * 100) : 0 },
                { label: "Failed", value: failed, color: "bg-red-500", pct: totalLeads > 0 ? Math.round((failed / totalLeads) * 100) : 0 },
              ].map((step) => (
                <div key={step.label} className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2">{step.label}</p>
                  <p className="text-2xl font-bold tabular-nums">{isLoading ? "—" : step.value.toLocaleString()}</p>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div className={`h-full rounded-full ${step.color}`} style={{ width: `${step.pct}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5 tabular-nums">{step.pct}% of total</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ── Recent Leads + Webhook Health ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">{t("home.recentLeads")}</CardTitle>
                <span
                  onClick={() => setLocation("/leads")}
                  className="text-xs text-primary hover:underline cursor-pointer"
                  role="link"
                >
                  {t("common.viewAll")}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {!leadsData?.items.length ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Zap className="h-8 w-8 text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">{t("home.noLeadsYet")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {leadsData.items.map((lead) => (
                    <div
                      key={lead.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => setLocation("/leads")}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{lead.fullName || "Unknown"}</p>
                        <p className="text-xs text-muted-foreground truncate">{lead.phone || lead.email || lead.leadgenId}</p>
                      </div>
                      <HomeLeadBadge lead={lead as LeadPipelineFields} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {isAdmin && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-semibold">{t("home.webhookHealth")}</CardTitle>
                  <span
                    onClick={() => setLocation("/webhook")}
                    className="text-xs text-primary hover:underline cursor-pointer"
                    role="link"
                  >
                    {t("home.viewDetails")}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <HealthRow label={t("home.totalEvents")} value={webhookStats?.total ?? 0} icon={Activity} />
                  <HealthRow label={t("home.verified")} value={webhookStats?.verified ?? 0} icon={CheckCircle2} positive />
                  <HealthRow label={t("home.processed")} value={webhookStats?.processed ?? 0} icon={TrendingUp} positive />
                </div>
                <div className="mt-4 pt-4 border-t">
                  <p className="text-xs text-muted-foreground">{t("home.webhookUrl")}</p>
                  <code className="text-xs bg-muted px-2 py-1 rounded mt-1 block truncate">/api/webhooks/facebook</code>
                </div>
              </CardContent>
            </Card>
          )}

          {!isAdmin && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Pipeline Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <HealthRow label={t("home.totalLeads")} value={stats?.leads.total ?? 0} icon={Zap} />
                  <HealthRow label={t("home.delivered")} value={stats?.leads.received ?? 0} icon={CheckCircle2} positive />
                  <HealthRow label={t("home.pending")} value={stats?.leads.pending ?? 0} icon={Clock} />
                  <HealthRow label={t("home.issues")} value={stats?.leads.failed ?? 0} icon={AlertCircle} />
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Lead Cost Summary — admin only ── */}
        {isAdmin && (
          <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <DollarSign className="h-4 w-4 text-primary" />
                  </div>
                  <span className="text-[15px] font-bold tracking-tight">Lead Cost Summary</span>
                  {leadCostData?.isStale && (
                    <Badge variant="outline" className="text-xs text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
                      ⚠ Stale
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {leadCostData?.lastSyncedAt && (
                    <span className="text-xs font-mono text-muted-foreground tabular-nums">
                      Updated {Math.round((Date.now() - new Date(leadCostData.lastSyncedAt).getTime()) / 60_000)}m ago
                    </span>
                  )}
                  <div className="flex rounded-full border bg-muted/50 p-0.5 gap-0.5">
                    {(["today", "yesterday", "last_7d", "last_30d"] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => { setLeadCostRange(r); setShowAllCampaigns(false); }}
                        className={`text-xs px-3 py-1 rounded-full transition-all duration-150 ${
                          leadCostRange === r
                            ? "bg-background text-foreground shadow-sm font-medium"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {r === "today" ? "Today" : r === "yesterday" ? "Yesterday" : r === "last_7d" ? "7d" : "30d"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </CardHeader>

            <CardContent className="pt-0">
              {leadCostLoading ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-muted-foreground">Loading…</p>
                </div>
              ) : !leadCostData || leadCostData.campaigns.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="h-10 w-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                    <DollarSign className="h-5 w-5 text-muted-foreground/30" />
                  </div>
                  <p className="text-sm text-muted-foreground">No leads with campaign attribution for this period</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 border rounded-lg overflow-hidden mb-5">
                    <div className="p-4 border-r border-b sm:border-b-0">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Total Leads</p>
                      <p className="text-2xl font-bold tabular-nums">{leadCostData.totals.totalLeads}</p>
                      <p className="text-xs mt-1 space-x-0.5">
                        <span className="text-emerald-600">✓ {leadCostData.totals.sentLeads} sent</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-red-500">✗ {leadCostData.totals.failedLeads} failed</span>
                      </p>
                    </div>
                    <div className="p-4 border-b sm:border-b-0 sm:border-r">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Pending</p>
                      <p className={`text-2xl font-bold tabular-nums ${leadCostData.totals.pendingLeads === 0 ? "text-muted-foreground" : ""}`}>
                        {leadCostData.totals.pendingLeads}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">processing queue</p>
                    </div>
                    <div className="p-4 border-r">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Est. Spend</p>
                      <p className="text-2xl font-bold tabular-nums">
                        ${leadCostData.totals.spend % 1 === 0 ? leadCostData.totals.spend.toFixed(0) : leadCostData.totals.spend.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">estimated · campaign level</p>
                    </div>
                    <div className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Est. CPL</p>
                      <p className={`text-2xl font-bold tabular-nums ${leadCostData.totals.cplSent != null ? getCplColor(leadCostData.totals.cplSent) : "text-muted-foreground"}`}>
                        {leadCostData.totals.cplSent != null ? `$${leadCostData.totals.cplSent.toFixed(2)}` : "—"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">per sent lead</p>
                    </div>
                  </div>

                  <div className="rounded-lg border overflow-hidden">
                    <div className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_90px_110px_80px] bg-muted/30 px-4 py-2 border-b">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Campaign</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-right">Leads</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-right hidden sm:block">Spend</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-right">CPL</span>
                    </div>
                    {(showAllCampaigns ? leadCostData.campaigns : leadCostData.campaigns.slice(0, 8)).map((c, i) => (
                      <div
                        key={c.campaignId}
                        className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_90px_110px_80px] px-4 py-3 border-b last:border-0 hover:bg-muted/20 transition-colors animate-in fade-in duration-200"
                        style={{ animationDelay: `${i * 30}ms` }}
                      >
                        <p className="text-sm truncate pr-4 max-w-[160px] sm:max-w-none" title={c.campaignName}>
                          {c.campaignName.replace(/ [|l] /g, " · ")}
                        </p>
                        <div className="text-right">
                          <p className="text-sm font-bold tabular-nums">{c.totalLeads}</p>
                          <p className="text-xs">
                            <span className="text-emerald-600">✓{c.sentLeads}</span>{" "}
                            <span className="text-red-500">✗{c.failedLeads}</span>
                          </p>
                        </div>
                        <div className="text-right hidden sm:block">
                          {c.spendAvailable ? (
                            <p className="text-sm tabular-nums">
                              ${(c.spend ?? 0) % 1 === 0 ? (c.spend ?? 0).toFixed(0) : (c.spend ?? 0).toFixed(2)}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground/40">—</p>
                          )}
                        </div>
                        <div className="text-right">
                          {c.spendAvailable && c.cplSent != null ? (
                            <p className={`text-sm font-bold tabular-nums ${getCplColor(c.cplSent)}`}>
                              ${c.cplSent.toFixed(2)}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground/40">—</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {leadCostData.campaigns.length > 8 && !showAllCampaigns && (
                    <button
                      onClick={() => setShowAllCampaigns(true)}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground border border-dashed rounded-lg hover:border-border hover:text-foreground transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                      Show {leadCostData.campaigns.length - 8} more campaigns
                    </button>
                  )}

                  <div className="mt-4 pt-3 border-t flex items-start gap-1.5">
                    <Info className="h-3 w-3 text-muted-foreground/40 mt-0.5 shrink-0" />
                    <p className="text-xs text-muted-foreground/50">
                      Estimated spend based on campaign-level insights cache · CPL on sent leads only
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}

// ─── Helper sub-components ────────────────────────────────────────────────────

function HomeLeadBadge({ lead }: { lead: LeadPipelineFields }) {
  return <LeadPipelineBadge lead={lead} size="compact" className="max-w-[9.5rem]" />;
}

function HealthRow({
  label,
  value,
  icon: Icon,
  positive,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  positive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${positive ? "text-emerald-500" : "text-muted-foreground"}`} />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}

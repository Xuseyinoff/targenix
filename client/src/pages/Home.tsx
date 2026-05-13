import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  DollarSign,
  Info,
  Link2,
  MoreHorizontal,
  Plug,
  Plus,
  Send,
  Shield,
  ShieldCheck,
  Sparkles,
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

function greeting(): { label: string; emoji: string } {
  const h = new Date().getHours();
  if (h < 5) return { label: "Good night", emoji: "🌙" };
  if (h < 12) return { label: "Good morning", emoji: "☀️" };
  if (h < 18) return { label: "Good afternoon", emoji: "👋" };
  return { label: "Good evening", emoji: "👋" };
}

function formatLongDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
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

// ─── Wapi-style "LIVE" KPI Card ──────────────────────────────────────────────

function LiveKpiCard({
  title,
  caption,
  value,
  icon: Icon,
  iconBg,
  iconColor,
  numberColor,
}: {
  title: string;
  caption: string;
  value: number | string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  numberColor: string;
}) {
  return (
    <div className="relative wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div className={`h-11 w-11 rounded-xl flex items-center justify-center ${iconBg}`}>
          <Icon className={`h-5 w-5 ${iconColor}`} strokeWidth={2.2} />
        </div>
        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/60 dark:border-emerald-900/40">
          <ArrowUpRight className="h-3 w-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
          <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 tracking-wider">LIVE</span>
        </div>
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
        {title}
      </p>
      <p className="text-[11px] text-slate-400 dark:text-muted-foreground/70 mt-0.5">
        {caption}
      </p>
      <p className={`text-3xl font-bold tabular-nums mt-3 ${numberColor}`}>
        {value}
      </p>
    </div>
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
  const { data: attention } = trpc.connections.attentionCount.useQuery(undefined, {
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: connectionsList } = trpc.connections.list.useQuery(undefined, { refetchInterval: 60_000 });

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
  const connectionsCount = connectionsList?.length ?? 0;
  const hasFacebookConnection = connectionsCount > 0;

  // Funnel data from all-time stats
  const totalLeads = stats?.leads.total ?? 0;
  const delivered = stats?.leads.received ?? 0;
  const pending = stats?.leads.pending ?? 0;
  const failed = stats?.leads.failed ?? 0;
  const attempted = delivered + failed;

  const chartPoints = timeSeries?.points ?? [];
  const xTickInterval = chartRange === "today" ? 3 : chartRange === "last_7d" ? 0 : 4;

  const g = greeting();
  const userName = user?.name?.split(" ")[0] ?? "there";

  return (
    <DashboardLayout>
      {/* ── Sticky page header (escapes main padding, blurs over content) ── */}
      <div className="sticky top-16 z-30 -mx-6 -mt-6 mb-5 bg-background/85 backdrop-blur-md border-b border-slate-200/70 dark:border-border">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-primary">Analytics Dashboard</h1>
            <p className="text-muted-foreground text-sm mt-0.5">Monitor your business performance in real time</p>
          </div>
          <div className="flex items-center gap-2 px-3 h-9 rounded-lg border border-input bg-background text-sm">
            <span className="text-muted-foreground">This Year</span>
            <ChevronRight className="h-3.5 w-3.5 rotate-90 text-muted-foreground" />
          </div>
        </div>
      </div>

      <div className="space-y-5 max-w-[1400px] mx-auto">
        {/* ── Attention banner ── */}
        {attention && attention.total > 0 && (
          <button
            type="button"
            onClick={() => setLocation("/connections")}
            className="flex w-full items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left transition-colors hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
          >
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {attention.total} connection{attention.total === 1 ? "" : "s"} need attention
              </div>
              <div className="text-xs text-amber-800/80 dark:text-amber-300/80">
                {[
                  attention.expired > 0 && `${attention.expired} expired`,
                  attention.revoked > 0 && `${attention.revoked} revoked`,
                  attention.error > 0 && `${attention.error} in error`,
                ].filter(Boolean).join(" · ")}
                {" — click to review"}
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
          </button>
        )}

        {/* ── Hero row: Greeting / Connect FB / Resource Insights ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Greeting card */}
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl overflow-hidden flex flex-col">
            {/* Emerald gradient header */}
            <div className="relative bg-gradient-to-br from-emerald-500 to-emerald-700 p-5 text-white">
              <div className="flex items-start justify-between mb-3">
                <span className="text-xs font-medium opacity-90">Targenix Workspace</span>
                <button className="h-7 w-7 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
              <div className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white/20 backdrop-blur-sm mb-3">
                <span className="text-[10px] font-bold tracking-widest uppercase">{g.label}</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                Hello, <span className="text-white">{userName}</span>
                <span className="text-2xl">{g.emoji}</span>
              </h2>
              <p className="text-sm opacity-90 mt-1">{formatLongDate()}</p>
            </div>
            {/* Quick Access */}
            <div className="p-5 flex-1">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-primary" />
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-700 dark:text-foreground">
                  Quick Access
                </h3>
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => setLocation("/leads")}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-muted/40 dark:hover:bg-muted/60 transition-colors text-left group"
                >
                  <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
                    <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">All Leads</p>
                    <p className="text-xs text-muted-foreground">Browse and triage incoming leads</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
                <button
                  onClick={() => setLocation("/integrations")}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-muted/40 dark:hover:bg-muted/60 transition-colors text-left group"
                >
                  <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
                    <Plug className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Integrations</p>
                    <p className="text-xs text-muted-foreground">Route leads to Telegram & destinations</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              </div>
            </div>
          </div>

          {/* Connect Facebook card */}
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5 flex flex-col relative overflow-hidden">
            <div className="flex items-start justify-between mb-3">
              <div className="h-11 w-11 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              {hasFacebookConnection && (
                <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-[10px] font-bold tracking-wider text-emerald-700 dark:text-emerald-400 uppercase">Verified</span>
                </div>
              )}
            </div>
            <h3 className="text-lg font-bold tracking-tight">Connect Facebook</h3>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Power your lead pipeline with a single Facebook account & Page subscription
            </p>
            <div className="grid grid-cols-2 gap-2 mb-4 flex-1">
              <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900/40 flex flex-col items-center justify-center text-center">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mb-1.5" />
                <span className="text-[11px] font-medium leading-tight">Facebook Login</span>
              </div>
              <div className="p-3 rounded-xl border border-slate-200/70 dark:border-border bg-slate-50/60 dark:bg-muted/30 flex flex-col items-center justify-center text-center">
                <Link2 className="h-4 w-4 text-slate-500 dark:text-muted-foreground mb-1.5" />
                <span className="text-[11px] font-medium leading-tight">Page Subscriptions</span>
              </div>
              <div className="col-span-2 p-3 rounded-xl border border-slate-200/70 dark:border-border bg-slate-50/60 dark:bg-muted/30 flex items-center justify-center gap-2">
                <Shield className="h-4 w-4 text-slate-500 dark:text-muted-foreground" />
                <span className="text-[11px] font-medium">HMAC-Verified Webhooks</span>
              </div>
            </div>
            <Button
              onClick={() => setLocation("/connections")}
              className="w-full rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-10"
            >
              <Plug className="h-4 w-4 mr-2" />
              Manage Connections
            </Button>
          </div>

          {/* Resource Insights stack */}
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold tracking-tight">Resource Insights</h3>
            </div>
            <div className="space-y-3">
              <ResourceRow
                label="Connected Pages"
                value={connectionsCount}
                hint="Facebook Pages with webhook"
                color="bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400"
                icon={Link2}
              />
              <ResourceRow
                label="Active Routes"
                value={activeIntegrations}
                hint="Lead routing → destination"
                color="bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400"
                icon={ArrowUpRight}
              />
              <ResourceRow
                label="Pending Leads"
                value={pending}
                hint="In queue for delivery"
                color="bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                icon={Clock}
              />
              {isAdmin && (
                <ResourceRow
                  label="Webhook Health"
                  value={webhookStats?.processed ?? 0}
                  hint="Processed events"
                  color="bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400"
                  icon={Webhook}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── Lead Performance — 4 LIVE KPI cards ── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h3 className="text-sm font-bold tracking-tight">Lead Performance</h3>
            <span className="text-xs text-muted-foreground">Key delivery insights</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <LiveKpiCard
              title="Leads Today"
              caption="New incoming leads"
              value={isLoading ? "—" : (stats?.leads.todayReceived ?? 0)}
              icon={Zap}
              iconBg="bg-indigo-100 dark:bg-indigo-950/40"
              iconColor="text-indigo-600 dark:text-indigo-400"
              numberColor="text-indigo-600 dark:text-indigo-400"
            />
            <LiveKpiCard
              title="Sent Today"
              caption="Delivered successfully"
              value={isLoading ? "—" : (stats?.orders.sentToday ?? 0)}
              icon={Send}
              iconBg="bg-sky-100 dark:bg-sky-950/40"
              iconColor="text-sky-600 dark:text-sky-400"
              numberColor="text-sky-600 dark:text-sky-400"
            />
            <LiveKpiCard
              title="All-Time Delivered"
              caption="Lifetime successful sends"
              value={isLoading ? "—" : (stats?.orders.sent ?? 0)}
              icon={CheckCircle2}
              iconBg="bg-emerald-100 dark:bg-emerald-950/40"
              iconColor="text-emerald-600 dark:text-emerald-400"
              numberColor="text-emerald-600 dark:text-emerald-400"
            />
            <LiveKpiCard
              title="Failed Today"
              caption="Need a retry"
              value={isLoading ? "—" : (stats?.todayIntegrationLeads?.leadsWithFailedDeliveryToday ?? 0)}
              icon={AlertTriangle}
              iconBg="bg-rose-100 dark:bg-rose-950/40"
              iconColor="text-rose-600 dark:text-rose-400"
              numberColor="text-rose-600 dark:text-rose-400"
            />
          </div>
        </div>

        {/* ── Lead Volume area chart ── */}
        <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold tracking-tight">Lead Volume</h3>
                <p className="text-xs text-muted-foreground">
                  {chartRange === "today" ? "Hourly breakdown" : `Daily totals — last ${chartRange === "last_7d" ? "7" : "30"} days`}
                </p>
              </div>
            </div>
            <RangeTabs value={chartRange} onChange={(r) => setChartRange(r)} />
          </div>
          {chartPoints.length === 0 ? (
            <div className="h-48 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">No data for this period</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartPoints} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradSent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
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
                <Area type="monotone" dataKey="total" name="leads" stroke="#10b981" strokeWidth={2.5} fill="url(#gradTotal)" dot={false} />
                <Area type="monotone" dataKey="sent" name="sent" stroke="#0ea5e9" strokeWidth={1.5} fill="url(#gradSent)" dot={false} />
                <Area type="monotone" dataKey="failed" name="failed" stroke="#f43f5e" strokeWidth={1.5} fill="url(#gradFailed)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          <div className="flex items-center gap-4 mt-2 justify-end">
            {[
              { color: "#10b981", label: "Leads" },
              { color: "#0ea5e9", label: "Sent" },
              { color: "#f43f5e", label: "Failed" },
            ].map((l) => (
              <div key={l.label} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
                <span className="text-xs text-muted-foreground">{l.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Top Sources + Delivery Performance — Wapi leaderboard style ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Top Sources */}
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-orange-100 dark:bg-orange-950/40 flex items-center justify-center">
                  <Zap className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold tracking-tight">Top Sources</h3>
                  <p className="text-xs text-muted-foreground">Lead volume by form</p>
                </div>
              </div>
              <RangeTabs value={sourcesRange} onChange={(r) => setSourcesRange(r)} />
            </div>
            {!topSources?.length ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="h-14 w-14 rounded-2xl bg-orange-50 dark:bg-orange-950/30 border border-orange-100 dark:border-orange-900/40 flex items-center justify-center mb-3">
                  <Zap className="h-6 w-6 text-orange-500/70" />
                </div>
                <p className="text-sm font-medium">No source data</p>
                <p className="text-xs text-muted-foreground mt-1">Lead activity by form will appear here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const maxTotal = Math.max(...topSources.map((s) => s.total), 1);
                  return topSources.map((source, idx) => {
                    const successRate = source.total > 0 ? Math.round((source.sent / source.total) * 100) : 0;
                    const rankStyle =
                      idx === 0 ? "bg-gradient-to-br from-amber-300 to-amber-500 text-white shadow-sm" :
                      idx === 1 ? "bg-gradient-to-br from-slate-300 to-slate-400 text-white shadow-sm" :
                      idx === 2 ? "bg-gradient-to-br from-orange-300 to-orange-500 text-white shadow-sm" :
                      "bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground";
                    const rateColor =
                      successRate >= 95 ? "text-emerald-600 dark:text-emerald-400" :
                      successRate >= 70 ? "text-amber-600 dark:text-amber-400" :
                      "text-rose-500 dark:text-rose-400";
                    return (
                      <div
                        key={source.label}
                        className="rounded-xl border border-slate-200/60 dark:border-border bg-slate-50/30 dark:bg-muted/15 p-3 transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15 group"
                      >
                        <div className="flex items-center gap-3">
                          <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${rankStyle}`}>
                            {idx + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate transition-colors group-hover:text-emerald-700 dark:group-hover:text-emerald-400" title={source.label}>
                              {source.label}
                            </p>
                            <div className="flex items-center gap-2 text-[11px] mt-0.5">
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">
                                ✓ {source.sent}
                              </span>
                              {source.failed > 0 && (
                                <>
                                  <span className="text-slate-300 dark:text-muted-foreground/40">·</span>
                                  <span className="inline-flex items-center gap-1 text-rose-500 dark:text-rose-400 font-medium tabular-nums">
                                    ✗ {source.failed}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-lg font-bold tabular-nums leading-none">{source.total}</p>
                            <p className={`text-[11px] font-bold tabular-nums mt-1 ${rateColor}`}>
                              {successRate}%
                            </p>
                          </div>
                        </div>
                        <div className="mt-2.5 h-1.5 w-full rounded-full bg-slate-100 dark:bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-500"
                            style={{ width: `${(source.total / maxTotal) * 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>

          {/* Delivery Performance */}
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="h-9 w-9 rounded-xl bg-sky-100 dark:bg-sky-950/40 flex items-center justify-center">
                <Send className="h-4 w-4 text-sky-600 dark:text-sky-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold tracking-tight">Delivery Performance</h3>
                <p className="text-xs text-muted-foreground">Success rate per destination</p>
              </div>
            </div>
            {!deliveryStats?.length ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="h-14 w-14 rounded-2xl bg-sky-50 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/40 flex items-center justify-center mb-3">
                  <Plug className="h-6 w-6 text-sky-500/70" />
                </div>
                <p className="text-sm font-medium">No delivery data</p>
                <p className="text-xs text-muted-foreground mt-1">Connect a destination to see performance</p>
              </div>
            ) : (
              <div className="space-y-2">
                {deliveryStats.map((d) => {
                  const status: "excellent" | "good" | "poor" =
                    d.successRate >= 95 ? "excellent" :
                    d.successRate >= 70 ? "good" :
                    "poor";
                  const statusConfig = {
                    excellent: {
                      icon: CheckCircle2,
                      iconBg: "bg-emerald-100 dark:bg-emerald-950/40",
                      iconColor: "text-emerald-600 dark:text-emerald-400",
                      numberColor: "text-emerald-600 dark:text-emerald-400",
                      barColor: "bg-gradient-to-r from-emerald-400 to-emerald-600",
                      label: "Excellent",
                      labelColor: "text-emerald-600 dark:text-emerald-400",
                    },
                    good: {
                      icon: Activity,
                      iconBg: "bg-amber-100 dark:bg-amber-950/40",
                      iconColor: "text-amber-600 dark:text-amber-400",
                      numberColor: "text-amber-600 dark:text-amber-400",
                      barColor: "bg-gradient-to-r from-amber-400 to-amber-500",
                      label: "Good",
                      labelColor: "text-amber-600 dark:text-amber-400",
                    },
                    poor: {
                      icon: AlertCircle,
                      iconBg: "bg-rose-100 dark:bg-rose-950/40",
                      iconColor: "text-rose-600 dark:text-rose-400",
                      numberColor: "text-rose-600 dark:text-rose-400",
                      barColor: "bg-gradient-to-r from-rose-400 to-rose-500",
                      label: "Attention",
                      labelColor: "text-rose-600 dark:text-rose-400",
                    },
                  }[status];
                  const Icon = statusConfig.icon;
                  return (
                    <div
                      key={d.integrationId}
                      className="rounded-xl border border-slate-200/60 dark:border-border bg-slate-50/30 dark:bg-muted/15 p-3 transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15 group"
                    >
                      <div className="flex items-center gap-3 mb-2.5">
                        <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${statusConfig.iconBg}`}>
                          <Icon className={`h-4 w-4 ${statusConfig.iconColor}`} strokeWidth={2.2} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate transition-colors group-hover:text-emerald-700 dark:group-hover:text-emerald-400" title={d.name}>
                            {d.name}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                            {d.sent.toLocaleString()} of {d.total.toLocaleString()} delivered
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-xl font-bold tabular-nums leading-none ${statusConfig.numberColor}`}>
                            {d.successRate}%
                          </p>
                          <p className={`text-[9px] uppercase tracking-widest font-bold mt-1 ${statusConfig.labelColor}`}>
                            {statusConfig.label}
                          </p>
                        </div>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${statusConfig.barColor}`}
                          style={{ width: `${d.successRate}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Lead Pipeline funnel ── */}
        <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="h-9 w-9 rounded-xl bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center">
              <TrendingUp className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-tight">Lead Pipeline</h3>
              <p className="text-xs text-muted-foreground">All-time conversion funnel</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              {
                label: "Total Leads",
                value: totalLeads,
                pct: 100,
                bar: "bg-indigo-500",
                iconBg: "bg-indigo-100 dark:bg-indigo-950/40",
                iconColor: "text-indigo-600 dark:text-indigo-400",
                numberColor: "text-indigo-600 dark:text-indigo-400",
                icon: Zap,
              },
              {
                label: "Attempted",
                value: attempted,
                pct: totalLeads > 0 ? Math.round((attempted / totalLeads) * 100) : 0,
                bar: "bg-sky-500",
                iconBg: "bg-sky-100 dark:bg-sky-950/40",
                iconColor: "text-sky-600 dark:text-sky-400",
                numberColor: "text-sky-600 dark:text-sky-400",
                icon: Send,
              },
              {
                label: "Delivered",
                value: delivered,
                pct: totalLeads > 0 ? Math.round((delivered / totalLeads) * 100) : 0,
                bar: "bg-emerald-500",
                iconBg: "bg-emerald-100 dark:bg-emerald-950/40",
                iconColor: "text-emerald-600 dark:text-emerald-400",
                numberColor: "text-emerald-600 dark:text-emerald-400",
                icon: CheckCircle2,
              },
              {
                label: "Failed",
                value: failed,
                pct: totalLeads > 0 ? Math.round((failed / totalLeads) * 100) : 0,
                bar: "bg-rose-500",
                iconBg: "bg-rose-100 dark:bg-rose-950/40",
                iconColor: "text-rose-600 dark:text-rose-400",
                numberColor: "text-rose-600 dark:text-rose-400",
                icon: AlertTriangle,
              },
            ].map((step) => (
              <div
                key={step.label}
                className="wapi-card-hover rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card p-5"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${step.iconBg}`}>
                    <step.icon className={`h-4 w-4 ${step.iconColor}`} strokeWidth={2.2} />
                  </div>
                  <span className="text-[10px] font-bold tracking-widest text-slate-400 dark:text-muted-foreground tabular-nums">
                    {step.pct}%
                  </span>
                </div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
                  {step.label}
                </p>
                <p className={`text-3xl font-bold tabular-nums mt-1.5 ${step.numberColor}`}>
                  {isLoading ? "—" : step.value.toLocaleString()}
                </p>
                <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100 dark:bg-muted overflow-hidden">
                  <div className={`h-full rounded-full ${step.bar}`} style={{ width: `${step.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Recent Leads + Webhook Health ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                  <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold tracking-tight">{t("home.recentLeads")}</h3>
                  <p className="text-xs text-muted-foreground">Latest incoming leads</p>
                </div>
              </div>
              <button
                onClick={() => setLocation("/leads")}
                className="text-xs font-medium text-primary hover:underline"
              >
                {t("common.viewAll")}
              </button>
            </div>
            {!leadsData?.items.length ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="h-12 w-12 rounded-full bg-slate-100 dark:bg-muted flex items-center justify-center mb-3">
                  <Zap className="h-5 w-5 text-slate-400 dark:text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">{t("home.noLeadsYet")}</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Leads will appear here as they come in</p>
              </div>
            ) : (
              <div className="space-y-2">
                {leadsData.items.map((lead) => {
                  const name = lead.fullName || "Unknown";
                  const initial = name.charAt(0).toUpperCase();
                  return (
                    <div
                      key={lead.id}
                      className="flex items-center gap-3 p-3 rounded-xl border border-slate-200/70 dark:border-border bg-white dark:bg-card hover:bg-slate-50 dark:hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => setLocation("/leads")}
                    >
                      <div className="h-10 w-10 rounded-full bg-emerald-500 dark:bg-emerald-600 text-white flex items-center justify-center shrink-0 font-semibold text-sm">
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{name}</p>
                        <p className="text-xs text-muted-foreground truncate">{lead.phone || lead.email || lead.leadgenId}</p>
                      </div>
                      <LeadPipelineBadge lead={lead as LeadPipelineFields} size="compact" className="max-w-[9.5rem]" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {isAdmin ? (
            <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="h-9 w-9 rounded-xl bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center">
                    <Webhook className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold tracking-tight">{t("home.webhookHealth")}</h3>
                    <p className="text-xs text-muted-foreground">Signature verification + processing</p>
                  </div>
                </div>
                <button
                  onClick={() => setLocation("/webhook")}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t("home.viewDetails")}
                </button>
              </div>
              <div className="space-y-3">
                <ResourceRow
                  label={t("home.totalEvents")}
                  value={webhookStats?.total ?? 0}
                  hint="Received webhook events"
                  color="bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400"
                  icon={Activity}
                />
                <ResourceRow
                  label={t("home.verified")}
                  value={webhookStats?.verified ?? 0}
                  hint="HMAC signature passed"
                  color="bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400"
                  icon={CheckCircle2}
                />
                <ResourceRow
                  label={t("home.processed")}
                  value={webhookStats?.processed ?? 0}
                  hint="Successfully fanned out"
                  color="bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400"
                  icon={TrendingUp}
                />
              </div>
              <div className="mt-4 pt-4 border-t border-slate-200/70 dark:border-border">
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground mb-1.5">
                  {t("home.webhookUrl")}
                </p>
                <code className="text-xs font-mono bg-slate-50 dark:bg-muted/40 border border-slate-200/70 dark:border-border px-2.5 py-1.5 rounded-lg block truncate">
                  /api/webhooks/facebook
                </code>
              </div>
            </div>
          ) : (
            <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="h-9 w-9 rounded-xl bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center">
                  <TrendingUp className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                </div>
                <h3 className="text-sm font-bold tracking-tight">Pipeline Summary</h3>
              </div>
              <div className="space-y-3">
                <ResourceRow
                  label={t("home.totalLeads")}
                  value={stats?.leads.total ?? 0}
                  hint="All-time lead count"
                  color="bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400"
                  icon={Zap}
                />
                <ResourceRow
                  label={t("home.delivered")}
                  value={stats?.leads.received ?? 0}
                  hint="Successfully sent"
                  color="bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400"
                  icon={CheckCircle2}
                />
                <ResourceRow
                  label={t("home.pending")}
                  value={stats?.leads.pending ?? 0}
                  hint="Awaiting delivery"
                  color="bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                  icon={Clock}
                />
                <ResourceRow
                  label={t("home.issues")}
                  value={stats?.leads.failed ?? 0}
                  hint="Need investigation"
                  color="bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400"
                  icon={AlertCircle}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── Lead Cost Summary — admin only ── */}
        {isAdmin && (
          <div className="wapi-card-hover bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                  <DollarSign className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold tracking-tight">Lead Cost Summary</h3>
                  <p className="text-xs text-muted-foreground">Spend insights from Facebook Marketing API</p>
                </div>
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

            {leadCostLoading ? (
              <div className="py-12 flex flex-col items-center justify-center">
                <div className="h-10 w-10 rounded-full border-2 border-emerald-200 border-t-emerald-600 animate-spin mb-3" />
                <p className="text-sm text-muted-foreground">Loading campaigns…</p>
              </div>
            ) : !leadCostData || leadCostData.campaigns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="h-14 w-14 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/40 flex items-center justify-center mb-3">
                  <DollarSign className="h-6 w-6 text-emerald-600/70 dark:text-emerald-400/70" />
                </div>
                <p className="text-sm font-medium text-foreground">No campaign spend data yet</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  Once leads with campaign attribution arrive in this period, spend &amp; CPL will appear here.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                  <div className="wapi-card-hover rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-7 w-7 rounded-lg bg-indigo-100 dark:bg-indigo-950/40 flex items-center justify-center">
                        <Zap className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                      </div>
                      <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">Total Leads</p>
                    </div>
                    <p className="text-2xl font-bold tabular-nums text-indigo-600 dark:text-indigo-400">{leadCostData.totals.totalLeads}</p>
                    <p className="text-xs mt-1.5 space-x-0.5">
                      <span className="text-emerald-600">✓ {leadCostData.totals.sentLeads}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-rose-500">✗ {leadCostData.totals.failedLeads}</span>
                    </p>
                  </div>
                  <div className="wapi-card-hover rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-7 w-7 rounded-lg bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
                        <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                      </div>
                      <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">Pending</p>
                    </div>
                    <p className={`text-2xl font-bold tabular-nums ${leadCostData.totals.pendingLeads === 0 ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>
                      {leadCostData.totals.pendingLeads}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5">processing queue</p>
                  </div>
                  <div className="wapi-card-hover rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-7 w-7 rounded-lg bg-sky-100 dark:bg-sky-950/40 flex items-center justify-center">
                        <DollarSign className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                      </div>
                      <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">Est. Spend</p>
                    </div>
                    <p className="text-2xl font-bold tabular-nums text-sky-600 dark:text-sky-400">
                      ${leadCostData.totals.spend % 1 === 0 ? leadCostData.totals.spend.toFixed(0) : leadCostData.totals.spend.toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5">campaign level</p>
                  </div>
                  <div className="wapi-card-hover rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                        <TrendingUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">Est. CPL</p>
                    </div>
                    <p className={`text-2xl font-bold tabular-nums ${leadCostData.totals.cplSent != null ? getCplColor(leadCostData.totals.cplSent) : "text-muted-foreground"}`}>
                      {leadCostData.totals.cplSent != null ? `$${leadCostData.totals.cplSent.toFixed(2)}` : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5">per sent lead</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200/70 dark:border-border overflow-hidden">
                  <div className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_90px_110px_80px] bg-slate-50/60 dark:bg-muted/30 px-4 py-2.5 border-b border-slate-200/70 dark:border-border">
                    <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">Campaign</span>
                    <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold text-right">Leads</span>
                    <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold text-right hidden sm:block">Spend</span>
                    <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold text-right">CPL</span>
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
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ─── Helper sub-components ────────────────────────────────────────────────────

function ResourceRow({
  label,
  value,
  hint,
  color,
  icon: Icon,
}: {
  label: string;
  value: number;
  hint: string;
  color: string;
  icon: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted-foreground truncate">{hint}</p>
      </div>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}


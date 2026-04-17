import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  Info,
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

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  variant = "default",
}: {
  title: string;
  value: number | string;
  description?: string;
  icon: React.ElementType;
  variant?: "default" | "success" | "warning" | "danger";
}) {
  const colors = {
    default: "text-primary bg-primary/10",
    success: "text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950",
    warning: "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-950",
    danger: "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-950",
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground font-medium">{title}</p>
            <p className="text-3xl font-bold tracking-tight">{value}</p>
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${colors[variant]}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === "admin";
  const refetchOpts = { refetchInterval: 5_000 };
  const { data: stats, isLoading } = trpc.leads.stats.useQuery(undefined, refetchOpts);
  const { data: webhookStats } = trpc.webhook.stats.useQuery(undefined, { ...refetchOpts, enabled: isAdmin });
  const { data: integrations } = trpc.integrations.list.useQuery(undefined, refetchOpts);
  const { data: leadsData } = trpc.leads.list.useQuery({ limit: 5, offset: 0 }, refetchOpts);

  const [leadCostRange, setLeadCostRange] = useState<"today" | "yesterday" | "last_7d" | "last_30d">("today");
  const [showAllCampaigns, setShowAllCampaigns] = useState(false);
  const { data: leadCostData, isLoading: leadCostLoading } = trpc.adAnalytics.getLeadCostSummary.useQuery(
    { dateRange: leadCostRange },
    { enabled: isAdmin, refetchInterval: 60_000 },
  );

  const activeIntegrations = integrations?.filter((i) => i.isActive).length ?? 0;

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-7xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("home.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("home.subtitle")}
          </p>
        </div>

        {/* Delivery & setup — first */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title={t("home.ordersSentToday")}
            value={isLoading ? "—" : (stats?.orders.sentToday ?? 0)}
            description={t("home.ordersSentTodayDesc")}
            icon={Calendar}
            variant="success"
          />
          <StatCard
            title={t("home.totalOrdersSent")}
            value={isLoading ? "—" : (stats?.orders.sent ?? 0)}
            description={t("home.totalOrdersSentDesc")}
            icon={TrendingUp}
            variant="success"
          />
          <StatCard
            title={t("home.activeIntegrations")}
            value={activeIntegrations}
            description={t("home.activeIntegrationsDesc")}
            icon={Plug}
          />
          {isAdmin && (
            <StatCard
              title={t("home.webhookEvents")}
              value={webhookStats?.total ?? 0}
              description={t("home.webhookEventsDesc")}
              icon={Webhook}
            />
          )}
        </div>

        {/* Today: lead-level integration outcomes (distinct leads) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatCard
            title={t("home.leadsWithDeliveryToday")}
            value={isLoading ? "—" : (stats?.todayIntegrationLeads?.leadsWithDeliveryToday ?? 0)}
            description={t("home.leadsWithDeliveryTodayDesc")}
            icon={Send}
            variant="success"
          />
          <StatCard
            title={t("home.leadsWithFailedToday")}
            value={isLoading ? "—" : (stats?.todayIntegrationLeads?.leadsWithFailedDeliveryToday ?? 0)}
            description={t("home.leadsWithFailedTodayDesc")}
            icon={AlertTriangle}
            variant="danger"
          />
        </div>

        {/* Lead pipeline */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title={t("home.totalLeads")}
            value={isLoading ? "—" : (stats?.leads.total ?? 0)}
            description={t("home.totalLeadsDesc")}
            icon={Zap}
          />
          <StatCard
            title={t("home.delivered")}
            value={isLoading ? "—" : (stats?.leads.received ?? 0)}
            description={t("home.deliveredDesc")}
            icon={CheckCircle2}
            variant="success"
          />
          <StatCard
            title={t("home.pending")}
            value={isLoading ? "—" : (stats?.leads.pending ?? 0)}
            description={t("home.pendingDesc")}
            icon={Clock}
            variant="warning"
          />
          <StatCard
            title={t("home.issues")}
            value={isLoading ? "—" : (stats?.leads.failed ?? 0)}
            description={t("home.issuesDesc")}
            icon={AlertCircle}
            variant="danger"
          />
        </div>

        {/* Recent Leads */}
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
              <CardDescription>{t("home.recentLeadsSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent>
              {!leadsData?.items.length ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Zap className="h-8 w-8 text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">{t("home.noLeadsYet")}</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    {t("home.noLeadsWebhook")}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {leadsData.items.map((lead) => (
                    <div
                      key={lead.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => setLocation("/leads")}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {lead.fullName || "Unknown"}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {lead.phone || lead.email || lead.leadgenId}
                        </p>
                      </div>
                      <HomeLeadBadge lead={lead as LeadPipelineFields} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Webhook Health Summary — admin only */}
          {isAdmin && <Card>
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
              <CardDescription>{t("home.webhookHealthSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <HealthRow
                  label={t("home.totalEvents")}
                  value={webhookStats?.total ?? 0}
                  icon={Activity}
                />
                <HealthRow
                  label={t("home.verified")}
                  value={webhookStats?.verified ?? 0}
                  icon={CheckCircle2}
                  positive
                />
                <HealthRow
                  label={t("home.processed")}
                  value={webhookStats?.processed ?? 0}
                  icon={TrendingUp}
                  positive
                />
              </div>
              <div className="mt-4 pt-4 border-t">
                <p className="text-xs text-muted-foreground">{t("home.webhookUrl")}</p>
                <code className="text-xs bg-muted px-2 py-1 rounded mt-1 block truncate">
                  /api/webhooks/facebook
                </code>
              </div>
            </CardContent>
          </Card>}
        </div>

        {/* Lead Cost Summary — admin only, full-width */}
        {isAdmin && (
          <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            {/* ── Header ── */}
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                {/* Left: icon box + title + stale badge */}
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
                {/* Right: freshness + pill tabs */}
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
                  {/* ── Metrics row ── */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 border rounded-lg overflow-hidden mb-5">
                    {/* Col 1 — Total Leads */}
                    <div className="p-4 border-r border-b sm:border-b-0">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Total Leads</p>
                      <p className="text-2xl font-bold tabular-nums">{leadCostData.totals.totalLeads}</p>
                      <p className="text-xs mt-1 space-x-0.5">
                        <span className="text-emerald-600">✓ {leadCostData.totals.sentLeads} sent</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-red-500">✗ {leadCostData.totals.failedLeads} failed</span>
                      </p>
                    </div>
                    {/* Col 2 — Pending */}
                    <div className="p-4 border-b sm:border-b-0 sm:border-r">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Pending</p>
                      <p className={`text-2xl font-bold tabular-nums ${leadCostData.totals.pendingLeads === 0 ? "text-muted-foreground" : ""}`}>
                        {leadCostData.totals.pendingLeads}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">processing queue</p>
                    </div>
                    {/* Col 3 — Est. Spend */}
                    <div className="p-4 border-r">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Est. Spend</p>
                      <p className="text-2xl font-bold tabular-nums">
                        ${leadCostData.totals.spend % 1 === 0
                          ? leadCostData.totals.spend.toFixed(0)
                          : leadCostData.totals.spend.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">estimated · campaign level</p>
                    </div>
                    {/* Col 4 — Est. CPL */}
                    <div className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Est. CPL</p>
                      <p className={`text-2xl font-bold tabular-nums ${leadCostData.totals.cplSent != null ? getCplColor(leadCostData.totals.cplSent) : "text-muted-foreground"}`}>
                        {leadCostData.totals.cplSent != null ? `$${leadCostData.totals.cplSent.toFixed(2)}` : "—"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">per sent lead</p>
                    </div>
                  </div>

                  {/* ── Campaign table ── */}
                  <div className="rounded-lg border overflow-hidden">
                    {/* Table header */}
                    <div className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_90px_110px_80px] bg-muted/30 px-4 py-2 border-b">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Campaign</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-right">Leads</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-right hidden sm:block">Spend</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-right">CPL</span>
                    </div>
                    {/* Rows */}
                    {(showAllCampaigns ? leadCostData.campaigns : leadCostData.campaigns.slice(0, 8)).map((c, i) => (
                      <div
                        key={c.campaignId}
                        className="grid grid-cols-[1fr_72px_72px] sm:grid-cols-[1fr_90px_110px_80px] px-4 py-3 border-b last:border-0 hover:bg-muted/20 transition-colors animate-in fade-in duration-200"
                        style={{ animationDelay: `${i * 30}ms` }}
                      >
                        {/* Campaign name */}
                        <p
                          className="text-sm truncate pr-4 max-w-[160px] sm:max-w-none"
                          title={c.campaignName}
                        >
                          {c.campaignName.replace(/ [|l] /g, " · ")}
                        </p>
                        {/* Leads */}
                        <div className="text-right">
                          <p className="text-sm font-bold tabular-nums">{c.totalLeads}</p>
                          <p className="text-xs">
                            <span className="text-emerald-600">✓{c.sentLeads}</span>{" "}
                            <span className="text-red-500">✗{c.failedLeads}</span>
                          </p>
                        </div>
                        {/* Spend — desktop only */}
                        <div className="text-right hidden sm:block">
                          {c.spendAvailable ? (
                            <p className="text-sm tabular-nums">
                              ${(c.spend ?? 0) % 1 === 0
                                ? (c.spend ?? 0).toFixed(0)
                                : (c.spend ?? 0).toFixed(2)}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground/40">—</p>
                          )}
                        </div>
                        {/* CPL */}
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

                  {/* ── Show more row ── */}
                  {leadCostData.campaigns.length > 8 && !showAllCampaigns && (
                    <button
                      onClick={() => setShowAllCampaigns(true)}
                      className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 text-xs text-muted-foreground border border-dashed rounded-lg hover:border-border hover:text-foreground transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                      Show {leadCostData.campaigns.length - 8} more campaigns
                    </button>
                  )}

                  {/* ── Footer note ── */}
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

function getCplColor(cpl: number): string {
  if (cpl < 0.35) return "text-emerald-600";
  if (cpl < 0.43) return "text-amber-600";
  return "text-red-600";
}

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

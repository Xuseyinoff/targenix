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
  Plug,
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
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base font-semibold">Lead Cost Summary</CardTitle>
                  {leadCostData?.isStale && (
                    <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                      Stale
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {leadCostData?.lastSyncedAt && (
                    <span className="text-xs text-muted-foreground">
                      Updated {Math.round((Date.now() - new Date(leadCostData.lastSyncedAt).getTime()) / 60000)}m ago
                    </span>
                  )}
                  <div className="flex gap-1">
                    {(["today", "yesterday", "last_7d", "last_30d"] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => setLeadCostRange(r)}
                        className={`text-xs px-2 py-1 rounded border transition-colors ${
                          leadCostRange === r
                            ? "bg-primary text-primary-foreground border-primary"
                            : "text-muted-foreground border-border hover:bg-muted"
                        }`}
                      >
                        {r === "today" ? "Today" : r === "yesterday" ? "Yesterday" : r === "last_7d" ? "7d" : "30d"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <CardDescription>
                Leads received vs estimated ad spend — data from DB cache (CPL based on sent leads)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {leadCostLoading ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
              ) : !leadCostData || leadCostData.campaigns.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <DollarSign className="h-7 w-7 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No leads with campaign attribution for this period</p>
                </div>
              ) : (
                <>
                  {/* Totals row */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    <div className="rounded-lg bg-muted/40 p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Total Leads</p>
                      <p className="text-xl font-bold">{leadCostData.totals.totalLeads}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        ✓ {leadCostData.totals.sentLeads} sent · ✗ {leadCostData.totals.failedLeads} failed
                      </p>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Pending</p>
                      <p className="text-xl font-bold">{leadCostData.totals.pendingLeads}</p>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Est. Spend</p>
                      <p className="text-xl font-bold">${leadCostData.totals.spend.toFixed(2)}</p>
                    </div>
                    <div className="rounded-lg bg-muted/40 p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Est. CPL (sent)</p>
                      <p className="text-xl font-bold">
                        {leadCostData.totals.cplSent != null ? `$${leadCostData.totals.cplSent.toFixed(2)}` : "—"}
                      </p>
                      {leadCostData.totals.cplTotal != null && leadCostData.totals.cplTotal !== leadCostData.totals.cplSent && (
                        <p className="text-xs text-muted-foreground mt-0.5">all: ${leadCostData.totals.cplTotal.toFixed(2)}</p>
                      )}
                    </div>
                  </div>
                  {/* Campaign breakdown */}
                  <div className="space-y-2 max-w-2xl">
                    {leadCostData.campaigns.slice(0, 8).map((c) => (
                      <div key={c.campaignId} className="flex items-center justify-between text-sm gap-3">
                        <p className="truncate text-muted-foreground flex-1 min-w-0" title={c.campaignName}>
                          {c.campaignName}
                        </p>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary">{c.totalLeads} leads</Badge>
                          <span className="text-xs text-muted-foreground/70">
                            ✓{c.sentLeads} ✗{c.failedLeads}
                          </span>
                          {c.spendAvailable ? (
                            <span className="text-xs text-muted-foreground w-40 text-right">
                              ${(c.spend ?? 0).toFixed(0)} ·{" "}
                              CPL {c.cplSent != null ? `$${c.cplSent.toFixed(2)}` : "—"}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/40 w-40 text-right">no spend data</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {leadCostData.campaigns.length > 8 && (
                      <p className="text-xs text-muted-foreground pt-1">
                        +{leadCostData.campaigns.length - 8} more campaigns
                      </p>
                    )}
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

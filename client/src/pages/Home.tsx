import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Plug,
  Send,
  TrendingUp,
  Webhook,
  Zap,
} from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import type { LeadPipelineFields } from "@/lib/leadPipelineBadgeModel";
import { LeadPipelineBadge } from "@/components/leads/PipelineBadges";

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
  const isAdmin = user?.role === "admin";
  const refetchOpts = { refetchInterval: 5_000 };
  const { data: stats, isLoading } = trpc.leads.stats.useQuery(undefined, refetchOpts);
  const { data: webhookStats } = trpc.webhook.stats.useQuery(undefined, { ...refetchOpts, enabled: isAdmin });
  const { data: integrations } = trpc.integrations.list.useQuery(undefined, refetchOpts);
  const { data: leadsData } = trpc.leads.list.useQuery({ limit: 5, offset: 0 }, refetchOpts);

  const activeIntegrations = integrations?.filter((i) => i.isActive).length ?? 0;

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-7xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Real-time Facebook Lead Ads processing dashboard
          </p>
        </div>

        {/* Delivery & setup — first */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Orders sent today"
            value={isLoading ? "—" : (stats?.orders.sentToday ?? 0)}
            description="Successful deliveries today"
            icon={Calendar}
            variant="success"
          />
          <StatCard
            title="Total orders sent"
            value={isLoading ? "—" : (stats?.orders.sent ?? 0)}
            description="All time, delivered to integrations"
            icon={TrendingUp}
            variant="success"
          />
          <StatCard
            title="Active Integrations"
            value={activeIntegrations}
            description="Telegram + Affiliate"
            icon={Plug}
          />
          {isAdmin && (
            <StatCard
              title="Webhook Events"
              value={webhookStats?.total ?? 0}
              description="Total received"
              icon={Webhook}
            />
          )}
        </div>

        {/* Today: lead-level integration outcomes (distinct leads) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatCard
            title="Leads with a delivery today"
            value={isLoading ? "—" : (stats?.todayIntegrationLeads?.leadsWithDeliveryToday ?? 0)}
            description="Unique leads with ≥1 integration send today"
            icon={Send}
            variant="success"
          />
          <StatCard
            title="Leads with a failed delivery today"
            value={isLoading ? "—" : (stats?.todayIntegrationLeads?.leadsWithFailedDeliveryToday ?? 0)}
            description="Unique leads with ≥1 failed integration attempt today"
            icon={AlertTriangle}
            variant="danger"
          />
        </div>

        {/* Lead pipeline */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Total Leads"
            value={isLoading ? "—" : (stats?.leads.total ?? 0)}
            description="All time"
            icon={Zap}
          />
          <StatCard
            title="Delivered"
            value={isLoading ? "—" : (stats?.leads.received ?? 0)}
            description="Graph OK and all integrations succeeded"
            icon={CheckCircle2}
            variant="success"
          />
          <StatCard
            title="Pending"
            value={isLoading ? "—" : (stats?.leads.pending ?? 0)}
            description="Queued or sending"
            icon={Clock}
            variant="warning"
          />
          <StatCard
            title="Issues"
            value={isLoading ? "—" : (stats?.leads.failed ?? 0)}
            description="Graph error or failed/partial delivery"
            icon={AlertCircle}
            variant="danger"
          />
        </div>

        {/* Recent Leads */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Recent Leads</CardTitle>
                <span
                  onClick={() => setLocation("/leads")}
                  className="text-xs text-primary hover:underline cursor-pointer"
                  role="link"
                >
                  View all →
                </span>
              </div>
              <CardDescription>Latest incoming leads from Facebook</CardDescription>
            </CardHeader>
            <CardContent>
              {!leadsData?.items.length ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Zap className="h-8 w-8 text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">No leads yet</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Leads will appear here once your webhook is connected
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
                <CardTitle className="text-base font-semibold">Webhook Health</CardTitle>
                <span
                  onClick={() => setLocation("/webhook")}
                  className="text-xs text-primary hover:underline cursor-pointer"
                  role="link"
                >
                  View details →
                </span>
              </div>
              <CardDescription>Signature verification and processing stats</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <HealthRow
                  label="Total Events"
                  value={webhookStats?.total ?? 0}
                  icon={Activity}
                />
                <HealthRow
                  label="Verified"
                  value={webhookStats?.verified ?? 0}
                  icon={CheckCircle2}
                  positive
                />
                <HealthRow
                  label="Processed"
                  value={webhookStats?.processed ?? 0}
                  icon={TrendingUp}
                  positive
                />
              </div>
              <div className="mt-4 pt-4 border-t">
                <p className="text-xs text-muted-foreground">Webhook URL:</p>
                <code className="text-xs bg-muted px-2 py-1 rounded mt-1 block truncate">
                  /api/webhooks/facebook
                </code>
              </div>
            </CardContent>
          </Card>}
        </div>
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

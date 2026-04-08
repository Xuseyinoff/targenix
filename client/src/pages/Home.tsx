import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Plug,
  TrendingUp,
  Webhook,
  Zap,
} from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";

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

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Total Leads"
            value={isLoading ? "—" : (stats?.leads.total ?? 0)}
            description="All time"
            icon={Zap}
          />
          <StatCard
            title="Received"
            value={isLoading ? "—" : (stats?.leads.received ?? 0)}
            description="Successfully processed"
            icon={CheckCircle2}
            variant="success"
          />
          <StatCard
            title="Pending"
            value={isLoading ? "—" : (stats?.leads.pending ?? 0)}
            description="In queue"
            icon={Clock}
            variant="warning"
          />
          <StatCard
            title="Failed"
            value={isLoading ? "—" : (stats?.leads.failed ?? 0)}
            description="Processing errors"
            icon={AlertCircle}
            variant="danger"
          />
        </div>

        {/* Second row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            title="Orders Sent"
            value={isLoading ? "—" : (stats?.orders.sent ?? 0)}
            description="Delivered to integrations"
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
                      <StatusBadge status={lead.status} />
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    PENDING: { label: "Pending", className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400" },
    RECEIVED: { label: "Received", className: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400" },
    FAILED: { label: "Failed", className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400" },
  };
  const s = map[status] ?? { label: status, className: "" };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${s.className}`}>
      {s.label}
    </span>
  );
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

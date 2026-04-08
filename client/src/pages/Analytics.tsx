import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Bell,
  DollarSign,
  MousePointerClick,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// ─── Date preset ──────────────────────────────────────────────────────────────
type DatePreset = "today" | "yesterday" | "last_7d" | "last_30d";

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7d: "Last 7 Days",
  last_30d: "Last 30 Days",
};

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
  trend,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  color: string;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              {title}
            </p>
            <p className="text-2xl font-semibold mt-1 truncate">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        {trend && (
          <div className="flex items-center gap-1 mt-2">
            {trend === "up" ? (
              <TrendingUp className="h-3 w-3 text-green-500" />
            ) : trend === "down" ? (
              <TrendingDown className="h-3 w-3 text-red-500" />
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────
function CustomTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border border-border rounded-lg shadow-lg p-3 text-xs">
      <p className="font-medium mb-2">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 mb-1">
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-medium">
            {entry.name === "Spend"
              ? new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency,
                  minimumFractionDigits: 2,
                }).format(entry.value)
              : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Analytics() {
  const [, setLocation] = useLocation();
  const [datePreset, setDatePreset] = useState<DatePreset>("last_30d");

  // Parse query params for pre-selected account
  const searchParams = useMemo(() => {
    if (typeof window === "undefined") return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);

  const preSelectedAccountId = searchParams.get("account") ?? "";
  const preSelectedFbAccountId = searchParams.get("fbAccountId") ?? "";

  // Fetch all ad accounts for the selector
  const { data: adAccounts, isLoading: isLoadingAccounts } =
    trpc.adAnalytics.listAdAccounts.useQuery();

  const [selectedAccountId, setSelectedAccountId] = useState(preSelectedAccountId);
  const [selectedFbAccountId, setSelectedFbAccountId] = useState(
    preSelectedFbAccountId ? parseInt(preSelectedFbAccountId, 10) : 0
  );

  // Auto-select first account if none selected
  useEffect(() => {
    if (!selectedAccountId && adAccounts && adAccounts.length > 0) {
      setSelectedAccountId(adAccounts[0].id);
      setSelectedFbAccountId(adAccounts[0].fbAccountId);
    }
  }, [adAccounts, selectedAccountId]);

  const selectedAccount = adAccounts?.find((a) => a.id === selectedAccountId);

  // Fetch insights for selected account with date preset
  const {
    data: insights,
    isLoading: isLoadingInsights,
    refetch: refetchInsights,
    isRefetching,
    error: insightsError,
  } = trpc.adAnalytics.getInsights.useQuery(
    { adAccountId: selectedAccountId, fbAccountId: selectedFbAccountId, datePreset },
    { enabled: !!selectedAccountId && !!selectedFbAccountId }
  );

  // Alert check mutation
  const checkAlerts = trpc.adAnalytics.checkAlerts.useMutation({
    onSuccess: (data) => {
      if (data.alerted) {
        toast.warning("Performance alert detected and sent to your notifications.");
      } else {
        toast.success("No anomalies detected in the last 24 hours.");
      }
    },
    onError: () => toast.error("Failed to run alert check."),
  });

  const handleAccountChange = (value: string) => {
    const account = adAccounts?.find((a) => a.id === value);
    if (account) {
      setSelectedAccountId(account.id);
      setSelectedFbAccountId(account.fbAccountId);
    }
  };

  const isTokenError =
    insightsError?.data?.code === "UNAUTHORIZED" ||
    insightsError?.message?.includes("token") ||
    insightsError?.message?.includes("reconnect");

  const currency = selectedAccount?.currency ?? insights?.currency ?? "USD";

  // Chart data — format dates for display
  const chartData = useMemo(() => {
    return (insights?.daily ?? []).map((d) => ({
      date: new Date(d.date + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      Spend: d.spend,
      Leads: d.leads,
    }));
  }, [insights]);

  const dateLabel = DATE_PRESET_LABELS[datePreset];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Lead Analytics</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Performance data from Meta Graph API v21.0
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Date range selector */}
            <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
              <SelectTrigger className="w-36 h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {DATE_PRESET_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Account selector */}
            <Select
              value={selectedAccountId}
              onValueChange={handleAccountChange}
              disabled={isLoadingAccounts}
            >
              <SelectTrigger className="w-56 h-9 text-sm">
                <SelectValue placeholder="Select ad account…" />
              </SelectTrigger>
              <SelectContent>
                {(adAccounts ?? []).map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    <span className="truncate">{acc.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refetchInsights();
                toast.info("Refreshing insights…");
              }}
              disabled={isRefetching || !selectedAccountId}
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={
                !selectedAccountId ||
                !selectedFbAccountId ||
                checkAlerts.isPending
              }
              onClick={() => {
                if (selectedAccount) {
                  checkAlerts.mutate({
                    adAccountId: selectedAccountId,
                    adAccountName: selectedAccount.name,
                    fbAccountId: selectedFbAccountId,
                  });
                }
              }}
              className="gap-1.5"
            >
              <Bell className="h-3.5 w-3.5" />
              Check Alerts
            </Button>
          </div>
        </div>

        {/* Token error banner */}
        {isTokenError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Facebook Token Expired</AlertTitle>
            <AlertDescription className="flex items-center gap-3 mt-1">
              Your Facebook access token has expired or lacks required permissions.
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => setLocation("/connections")}
              >
                Reconnect Account
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* No account selected */}
        {!selectedAccountId && !isLoadingAccounts && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
              <BarChart3 className="h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                {adAccounts?.length === 0
                  ? "No ad accounts found. Connect a Facebook account with ads_management permission."
                  : "Select an ad account to view analytics."}
              </p>
              {adAccounts?.length === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocation("/connections")}
                >
                  Connect Facebook Account
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* KPI Cards */}
        {(insights || isLoadingInsights) && selectedAccountId && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Total Spend"
              value={
                isLoadingInsights
                  ? "—"
                  : new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency,
                      maximumFractionDigits: 2,
                    }).format(insights?.totalSpend ?? 0)
              }
              subtitle={dateLabel}
              icon={DollarSign}
              color="bg-blue-500/10 text-blue-500"
            />
            <KpiCard
              title="Total Leads"
              value={isLoadingInsights ? "—" : String(insights?.totalLeads ?? 0)}
              subtitle={dateLabel}
              icon={Users}
              color="bg-green-500/10 text-green-500"
            />
            <KpiCard
              title="Avg CPL"
              value={
                isLoadingInsights
                  ? "—"
                  : insights?.avgCpl
                  ? new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency,
                      minimumFractionDigits: 2,
                    }).format(insights.avgCpl)
                  : "N/A"
              }
              subtitle="Cost per lead"
              icon={TrendingDown}
              color="bg-orange-500/10 text-orange-500"
            />
            <KpiCard
              title="Avg CTR"
              value={isLoadingInsights ? "—" : `${insights?.avgCtr?.toFixed(2) ?? "0.00"}%`}
              subtitle="Click-through rate"
              icon={MousePointerClick}
              color="bg-purple-500/10 text-purple-500"
            />
          </div>
        )}

        {/* Dual-axis Line Chart */}
        {selectedAccountId && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-medium">
                    Spend vs. Lead Volume
                  </CardTitle>
                  <CardDescription>
                    Daily breakdown — {dateLabel}
                    {selectedAccount && (
                      <span className="ml-2 text-xs">
                        · {selectedAccount.name}
                      </span>
                    )}
                  </CardDescription>
                </div>
                {insights && (
                  <Badge variant="outline" className="text-xs">
                    {currency}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingInsights ? (
                <div className="flex items-center justify-center h-64">
                  <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !insights || chartData.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 gap-2">
                  <BarChart3 className="h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    No data available for the selected period.
                  </p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 24, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    {/* Left Y-axis: Spend */}
                    <YAxis
                      yAxisId="spend"
                      orientation="left"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) =>
                        new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency,
                          notation: "compact",
                          maximumFractionDigits: 1,
                        }).format(v)
                      }
                    />
                    {/* Right Y-axis: Leads */}
                    <YAxis
                      yAxisId="leads"
                      orientation="right"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      content={<CustomTooltip currency={currency} />}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                    />
                    <Line
                      yAxisId="spend"
                      type="monotone"
                      dataKey="Spend"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                    <Line
                      yAxisId="leads"
                      type="monotone"
                      dataKey="Leads"
                      stroke="#22c55e"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        )}

        {/* Daily breakdown table */}
        {insights && chartData.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-medium">Daily Breakdown</CardTitle>
              <CardDescription>CPL and CTR per day — {dateLabel}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 pl-6 text-xs font-medium text-muted-foreground">Date</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Spend</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Impressions</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Clicks</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Leads</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">CPL</th>
                      <th className="text-right py-2 pr-6 text-xs font-medium text-muted-foreground">CTR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(insights.daily ?? [])].reverse().map((row) => (
                      <tr key={row.date} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="py-2 pl-6 text-xs text-muted-foreground">{row.date}</td>
                        <td className="py-2 text-right text-xs">
                          {new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency,
                            minimumFractionDigits: 2,
                          }).format(row.spend)}
                        </td>
                        <td className="py-2 text-right text-xs">{row.impressions.toLocaleString()}</td>
                        <td className="py-2 text-right text-xs">{row.clicks.toLocaleString()}</td>
                        <td className="py-2 text-right text-xs font-medium text-green-600">{row.leads}</td>
                        <td className="py-2 text-right text-xs">
                          {row.cpl > 0
                            ? new Intl.NumberFormat("en-US", {
                                style: "currency",
                                currency,
                                minimumFractionDigits: 2,
                              }).format(row.cpl)
                            : "—"}
                        </td>
                        <td className="py-2 pr-6 text-right text-xs">{row.ctr.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Data from Meta Graph API v21.0 · Cached 10 min · appsecret_proof secured
        </p>
      </div>
    </DashboardLayout>
  );
}

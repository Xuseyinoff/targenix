import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock,
  DollarSign,
  Globe,
  RefreshCw,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useLocation } from "wouter";
import { toast } from "sonner";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatCurrency(cents: string, currency: string): string {
  const amount = parseInt(cents, 10) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "Never";
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type AccountStatus =
  | "ACTIVE" | "DISABLED" | "UNSETTLED" | "PENDING_RISK_REVIEW"
  | "PENDING_SETTLEMENT" | "IN_GRACE_PERIOD" | "PENDING_CLOSURE"
  | "CLOSED" | "ANY_ACTIVE" | "ANY_CLOSED" | "UNKNOWN";

function StatusBadge({ status }: { status: AccountStatus }) {
  const config: Record<AccountStatus, { label: string; className: string }> = {
    ACTIVE: { label: "Active", className: "text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-900 dark:text-green-400" },
    DISABLED: { label: "Disabled", className: "text-red-600 border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 dark:text-red-400" },
    UNSETTLED: { label: "Unsettled", className: "text-orange-600 border-orange-200 bg-orange-50" },
    PENDING_RISK_REVIEW: { label: "Risk Review", className: "text-yellow-600 border-yellow-200 bg-yellow-50" },
    PENDING_SETTLEMENT: { label: "Pending", className: "text-blue-600 border-blue-200 bg-blue-50" },
    IN_GRACE_PERIOD: { label: "Grace Period", className: "text-purple-600 border-purple-200 bg-purple-50" },
    PENDING_CLOSURE: { label: "Closing", className: "text-red-500 border-red-200 bg-red-50" },
    CLOSED: { label: "Closed", className: "text-gray-500 border-gray-200 bg-gray-50" },
    ANY_ACTIVE: { label: "Active", className: "text-green-600 border-green-200 bg-green-50" },
    ANY_CLOSED: { label: "Closed", className: "text-gray-500 border-gray-200 bg-gray-50" },
    UNKNOWN: { label: "Unknown", className: "text-gray-400 border-gray-200 bg-gray-50" },
  };
  const { label, className } = config[status] ?? config.UNKNOWN;
  return <Badge variant="outline" className={`text-xs font-medium ${className}`}>{label}</Badge>;
}

function SyncIndicator({ lastSyncedAt, isStale }: { lastSyncedAt: string | null; isStale: boolean }) {
  return (
    <div className={`flex items-center gap-1 text-xs ${isStale ? "text-amber-500" : "text-muted-foreground"}`}>
      {isStale ? <WifiOff className="h-3 w-3" /> : <Wifi className="h-3 w-3 text-green-500" />}
      <span>{formatRelativeTime(lastSyncedAt)}</span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function AdAccounts() {
  const [, setLocation] = useLocation();

  const {
    data: accounts,
    isLoading,
    refetch,
    isRefetching,
    error,
  } = trpc.adAnalytics.listAdAccounts.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000, // auto-refetch every 10 min
  });

  const { data: syncStatuses } = trpc.adAnalytics.getSyncStatus.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

  const syncNow = trpc.adAnalytics.syncNow.useMutation({
    onSuccess: (result) => {
      toast.success(`Synced: ${result.accounts} accounts, ${result.campaigns} campaigns`);
      void refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const activeCount = accounts?.filter((a) => a.status === "ACTIVE").length ?? 0;
  const totalSpend = accounts?.reduce((sum, a) => sum + parseInt(a.amountSpent, 10) / 100, 0) ?? 0;

  // Determine if any account is stale
  const anyStale = syncStatuses?.some((s) => s.isStale) ?? false;
  const lastSyncedAt = syncStatuses?.map((s) => s.lastSyncedAt).filter(Boolean).sort().reverse()[0] ?? null;

  const isTokenError =
    error?.data?.code === "UNAUTHORIZED" ||
    error?.message?.includes("token") ||
    error?.message?.includes("reconnect") ||
    error?.message?.includes("OAuthException");

  const handleSyncAll = () => {
    if (!syncStatuses || syncStatuses.length === 0) {
      toast.info("No connected Facebook accounts");
      return;
    }
    toast.info("Syncing all ad accounts…");
    for (const status of syncStatuses) {
      syncNow.mutate({ fbAccountId: status.fbAccountId });
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Ad Accounts</h1>
            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
              Facebook Advertising Accounts
              {lastSyncedAt && (
                <span className={`inline-flex items-center gap-1 ${anyStale ? "text-amber-500" : "text-muted-foreground"}`}>
                  <Clock className="h-3 w-3" />
                  Last synced: {formatRelativeTime(lastSyncedAt)}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncAll}
              disabled={syncNow.isPending || isRefetching}
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncNow.isPending ? "animate-spin" : ""}`} />
              Sync Now
            </Button>
            <Button
              size="sm"
              onClick={() => setLocation("/business/analytics")}
              className="gap-1.5"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Analytics
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Users className="h-4 w-4 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">{accounts?.length ?? 0}</p>
                  <p className="text-xs text-muted-foreground">Total Ad Accounts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">{activeCount}</p>
                  <p className="text-xs text-muted-foreground">Active Accounts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-orange-500/10 flex items-center justify-center">
                  <DollarSign className="h-4 w-4 text-orange-500" />
                </div>
                <div>
                  <p className="text-2xl font-semibold">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalSpend)}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Lifetime Spend</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sync status banners */}
        {anyStale && !isLoading && (
          <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
            <WifiOff className="h-4 w-4 text-amber-500" />
            <AlertTitle className="text-amber-700 dark:text-amber-400">Data may be outdated</AlertTitle>
            <AlertDescription className="flex items-center gap-3 text-amber-600 dark:text-amber-500">
              Last sync was more than 8 minutes ago. Click "Sync Now" to refresh.
              <Button size="sm" variant="outline" className="shrink-0 border-amber-300 text-amber-700 hover:bg-amber-100" onClick={handleSyncAll}>
                Sync Now
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {isTokenError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Facebook Token Expired</AlertTitle>
            <AlertDescription className="flex items-center gap-3 mt-1">
              Your Facebook access token has expired or lacks ad permissions.
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setLocation("/connections")}>
                Reconnect Facebook
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Ad Accounts table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">Ad Accounts</CardTitle>
            <CardDescription>
              Synced from Meta Marketing API every 10 minutes · Read from DB cache
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <RefreshCw className="h-6 w-6 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">
                  Syncing your ad accounts from Meta…
                </p>
                <p className="text-xs text-muted-foreground/60">
                  First load takes a moment — future loads will be instant
                </p>
              </div>
            ) : !accounts || accounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <AlertCircle className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {error
                    ? "Failed to load. Check your Facebook connection."
                    : "No ad accounts found. Sync your Facebook account or connect one with ad permissions."}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleSyncAll}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" /> Sync Now
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setLocation("/connections")}>
                    Connect Facebook
                  </Button>
                </div>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>Total Spend</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead>Last Synced</TableHead>
                    <TableHead className="pr-6">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.id} className="hover:bg-muted/30">
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-blue-500/10 flex items-center justify-center text-xs font-semibold text-blue-600">
                            {account.name?.charAt(0).toUpperCase() ?? "A"}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{account.name}</p>
                            <p className="text-xs text-muted-foreground font-mono">{account.id}</p>
                            {account.fbUserName && (
                              <p className="text-xs text-muted-foreground/70">{account.fbUserName}</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={account.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm">
                          <Globe className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">{account.currency}</span>
                          {account.timezone && (
                            <span className="text-xs text-muted-foreground">· {account.timezone}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">
                          {formatCurrency(account.amountSpent, account.currency)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{formatCurrency(account.balance, account.currency)}</span>
                      </TableCell>
                      <TableCell>
                        <SyncIndicator
                          lastSyncedAt={account.lastSyncedAt}
                          isStale={!account.lastSyncedAt || Date.now() - new Date(account.lastSyncedAt).getTime() > 8 * 60 * 1000}
                        />
                      </TableCell>
                      <TableCell className="pr-6">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() => setLocation(`/business/analytics?account=${encodeURIComponent(account.id)}&fbAccountId=${account.fbAccountId}`)}
                          >
                            <BarChart3 className="h-3 w-3" />
                            Analytics
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() => setLocation(`/business/ad-accounts/${encodeURIComponent(account.id)}__fbAccountId_${account.fbAccountId}/campaigns`)}
                          >
                            <ChevronRight className="h-3 w-3" />
                            Campaigns
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Data cached in DB from Meta Graph API v21.0 · Background sync every 10 min · Secured with appsecret_proof
        </p>
      </div>
    </DashboardLayout>
  );
}

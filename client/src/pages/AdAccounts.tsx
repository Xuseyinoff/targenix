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
  DollarSign,
  RefreshCw,
  Users,
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

type AccountStatus =
  | "ACTIVE"
  | "DISABLED"
  | "UNSETTLED"
  | "PENDING_RISK_REVIEW"
  | "PENDING_SETTLEMENT"
  | "IN_GRACE_PERIOD"
  | "PENDING_CLOSURE"
  | "CLOSED"
  | "ANY_ACTIVE"
  | "ANY_CLOSED"
  | "UNKNOWN";

function StatusBadge({ status }: { status: AccountStatus }) {
  const config: Record<AccountStatus, { label: string; className: string }> = {
    ACTIVE: { label: "Active", className: "text-green-600 border-green-200 bg-green-50" },
    DISABLED: { label: "Disabled", className: "text-red-600 border-red-200 bg-red-50" },
    UNSETTLED: { label: "Unsettled", className: "text-orange-600 border-orange-200 bg-orange-50" },
    PENDING_RISK_REVIEW: { label: "Risk Review", className: "text-yellow-600 border-yellow-200 bg-yellow-50" },
    PENDING_SETTLEMENT: { label: "Pending Settlement", className: "text-blue-600 border-blue-200 bg-blue-50" },
    IN_GRACE_PERIOD: { label: "Grace Period", className: "text-purple-600 border-purple-200 bg-purple-50" },
    PENDING_CLOSURE: { label: "Pending Closure", className: "text-red-500 border-red-200 bg-red-50" },
    CLOSED: { label: "Closed", className: "text-gray-500 border-gray-200 bg-gray-50" },
    ANY_ACTIVE: { label: "Active", className: "text-green-600 border-green-200 bg-green-50" },
    ANY_CLOSED: { label: "Closed", className: "text-gray-500 border-gray-200 bg-gray-50" },
    UNKNOWN: { label: "Unknown", className: "text-gray-400 border-gray-200 bg-gray-50" },
  };

  const { label, className } = config[status] ?? config.UNKNOWN;
  return (
    <Badge variant="outline" className={`text-xs font-medium ${className}`}>
      {label}
    </Badge>
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
  } = trpc.adAnalytics.listAdAccounts.useQuery();

  const activeCount = accounts?.filter((a) => a.status === "ACTIVE").length ?? 0;
  const totalSpend = accounts?.reduce((sum, a) => {
    return sum + parseInt(a.amountSpent, 10) / 100;
  }, 0) ?? 0;

  const handleRefresh = () => {
    refetch();
    toast.info("Refreshing ad accounts…");
  };

  // Check if error is token-related (401/403)
  const isTokenError =
    error?.data?.code === "UNAUTHORIZED" ||
    error?.message?.includes("token") ||
    error?.message?.includes("reconnect") ||
    error?.message?.includes("OAuthException");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Ad Accounts</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Facebook Ad Accounts from Meta Graph API v21.0
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefetching}
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => setLocation("/business/analytics")}
              className="gap-1.5"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              View Analytics
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
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    }).format(totalSpend)}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Lifetime Spend</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Token error banner (401/403) */}
        {isTokenError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Facebook Token Expired or Insufficient Permissions</AlertTitle>
            <AlertDescription className="flex items-center gap-3 mt-1">
              Your Facebook access token has expired or lacks required ad permissions (ads_management).
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => setLocation("/connections")}
              >
                Reconnect Facebook Account
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Ad Accounts table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">Ad Accounts</CardTitle>
            <CardDescription>
              All Facebook Ad Accounts connected to your workspace via Meta Graph API
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !accounts || accounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <AlertCircle className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {error
                    ? "Failed to load ad accounts. Check your Facebook connection."
                    : "No ad accounts found. Connect a Facebook account with ad permissions."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocation("/connections")}
                >
                  Connect Facebook Account
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">Ad Account Name</TableHead>
                    <TableHead>Account ID</TableHead>
                    <TableHead>Total Spend</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead>Status</TableHead>
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
                            <p className="text-xs text-muted-foreground">{account.fbUserName}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-mono text-muted-foreground">
                          {account.id}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">
                          {formatCurrency(account.amountSpent, account.currency)}
                        </span>
                        <span className="text-xs text-muted-foreground ml-1">
                          {account.currency}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">
                          {formatCurrency(account.balance, account.currency)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={account.status} />
                      </TableCell>
                      <TableCell className="pr-6">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() =>
                              setLocation(
                                `/business/analytics?account=${encodeURIComponent(account.id)}&fbAccountId=${account.fbAccountId}`
                              )
                            }
                          >
                            <BarChart3 className="h-3 w-3" />
                            Analytics
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() =>
                              setLocation(
                                `/business/ad-accounts/${encodeURIComponent(account.id)}__fbAccountId_${account.fbAccountId}/campaigns`
                              )
                            }
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

        {/* Info note */}
        <p className="text-xs text-muted-foreground">
          Data fetched from Meta Graph API v21.0 · Cached for 10 minutes · Secured with appsecret_proof
        </p>
      </div>
    </DashboardLayout>
  );
}

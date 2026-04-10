import { useRoute, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ArrowLeft, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  ChevronsUpDown, RefreshCw, AlertTriangle, TrendingUp, Users,
  DollarSign, MousePointer, Search, Layers,
} from "lucide-react";
import { useState, useMemo } from "react";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────
type DatePreset = "today" | "yesterday" | "last_7d" | "last_30d";
type SortField = "spend" | "leads" | "cpl" | "ctr" | "convRate";
type SortDir = "asc" | "desc";
type StatusFilter = "ALL" | "ACTIVE" | "PAUSED";

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today", yesterday: "Yesterday", last_7d: "Last 7 Days", last_30d: "Last 30 Days",
};

const PAGE_SIZE = 25;

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: currency || "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string { return `${value.toFixed(2)}%`; }

function CampaignStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    PAUSED: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    DELETED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    ARCHIVED: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${variants[status] ?? variants.ARCHIVED}`}>
      {status}
    </span>
  );
}

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (sortField !== field) return <ChevronsUpDown className="inline h-3 w-3 ml-1 text-muted-foreground/40" />;
  return sortDir === "desc" ? <ChevronDown className="inline h-3 w-3 ml-1" /> : <ChevronUp className="inline h-3 w-3 ml-1" />;
}

function ReconnectAlert() {
  const [, navigate] = useLocation();
  return (
    <Alert variant="destructive" className="mb-6">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Facebook Token Expired</AlertTitle>
      <AlertDescription className="flex items-center gap-3 mt-1">
        Your Facebook access token has expired or lacks required permissions.
        <Button size="sm" variant="outline" onClick={() => navigate("/connections")}>
          Reconnect Facebook
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Campaigns() {
  const [, params] = useRoute("/business/ad-accounts/:id/campaigns");
  const [, navigate] = useLocation();

  const [datePreset, setDatePreset] = useState<DatePreset>("last_30d");
  const [sortField, setSortField] = useState<SortField>("spend");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const rawId = params?.id ?? "";
  const parts = rawId.split("__fbAccountId_");
  const adAccountId = parts[0] ?? "";
  const fbAccountId = parseInt(parts[1] ?? "0", 10);
  const isValidRoute = adAccountId.startsWith("act_") && fbAccountId > 0;

  const { data: campaigns, isLoading: campaignsLoading, error: campaignsError } =
    trpc.adAnalytics.listCampaigns.useQuery(
      { adAccountId, fbAccountId },
      { enabled: isValidRoute, staleTime: 8 * 60 * 1000 }
    );

  const { data: insights, isLoading: insightsLoading, refetch: refetchInsights, error: insightsError } =
    trpc.adAnalytics.getCampaignInsights.useQuery(
      { adAccountId, fbAccountId, datePreset },
      { enabled: isValidRoute, staleTime: 8 * 60 * 1000 }
    );

  const syncNow = trpc.adAnalytics.syncNow.useMutation({
    onSuccess: () => {
      toast.success("Sync complete");
      void refetchInsights();
    },
    onError: (e) => toast.error(e.message),
  });

  const isLoading = campaignsLoading || insightsLoading;
  const isAuthError =
    campaignsError?.data?.code === "UNAUTHORIZED" ||
    insightsError?.data?.code === "UNAUTHORIZED" ||
    campaignsError?.message?.includes("reconnect") ||
    insightsError?.message?.includes("reconnect");

  // Build insights map
  const insightsMap = new Map((insights?.campaigns ?? []).map((c) => [c.campaignId, c]));
  const currency = insights?.currency ?? "USD";

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortField(field); setSortDir("desc"); }
    setPage(1);
  };

  // Merge + filter + sort
  const processedCampaigns = useMemo(() => {
    if (!campaigns) return [];
    return campaigns
      .filter((c) => {
        if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
        if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        const insA = insightsMap.get(a.id);
        const insB = insightsMap.get(b.id);
        const getVal = (ins: typeof insA): number => {
          if (!ins) return -Infinity;
          switch (sortField) {
            case "spend": return ins.spend;
            case "leads": return ins.leads;
            case "cpl": return ins.cpl;
            case "ctr": return ins.ctr;
            case "convRate": return ins.conversionRate;
          }
        };
        const diff = getVal(insA) - getVal(insB);
        return sortDir === "desc" ? -diff : diff;
      });
  }, [campaigns, insightsMap, sortField, sortDir, statusFilter, search]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(processedCampaigns.length / PAGE_SIZE));
  const pagedCampaigns = processedCampaigns.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (!isValidRoute) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-muted-foreground">
          Invalid campaign URL. Navigate from the Ad Accounts page.
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/business/ad-accounts")} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Ad Accounts
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Campaign Analytics</h1>
              <p className="text-sm text-muted-foreground font-mono">{adAccountId}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={datePreset} onValueChange={(v) => { setDatePreset(v as DatePreset); setPage(1); }}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((preset) => (
                  <SelectItem key={preset} value={preset}>{DATE_PRESET_LABELS[preset]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline" size="sm"
              onClick={() => syncNow.mutate({ fbAccountId })}
              disabled={syncNow.isPending || isLoading}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${(syncNow.isPending || isLoading) ? "animate-spin" : ""}`} />
              Sync
            </Button>
          </div>
        </div>

        {isAuthError && <ReconnectAlert />}

        {/* KPI Cards */}
        {insights && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <DollarSign className="h-4 w-4" /> Total Spend
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatCurrency(insights.totalSpend, currency)}</p>
                <p className="text-xs text-muted-foreground mt-1">{DATE_PRESET_LABELS[datePreset]}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Users className="h-4 w-4" /> Total Leads
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{insights.totalLeads.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">{DATE_PRESET_LABELS[datePreset]}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" /> Avg CPL
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {insights.avgCpl > 0 ? formatCurrency(insights.avgCpl, currency) : "N/A"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Cost per lead</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <MousePointer className="h-4 w-4" /> Avg CTR
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPercent(insights.avgCtr)}</p>
                <p className="text-xs text-muted-foreground mt-1">Click-through rate</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Campaigns Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <CardTitle className="text-base">
                Campaigns
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({processedCampaigns.length}{campaigns && processedCampaigns.length !== campaigns.length ? ` of ${campaigns.length}` : ""} total)
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search campaigns…"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    className="h-8 pl-8 w-52 text-sm"
                  />
                </div>
                {/* Status filter */}
                <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as StatusFilter); setPage(1); }}>
                  <SelectTrigger className="h-8 w-28 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Status</SelectItem>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="PAUSED">Paused</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                <RefreshCw className="h-6 w-6 animate-spin text-primary" />
                <p className="text-sm">Syncing campaigns from Meta…</p>
                <p className="text-xs text-muted-foreground/60">First load syncs automatically</p>
              </div>
            ) : isAuthError ? (
              <div className="p-6 text-center text-muted-foreground">
                Please reconnect your Facebook account.
              </div>
            ) : processedCampaigns.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">
                {search || statusFilter !== "ALL"
                  ? "No campaigns match your filters."
                  : "No campaigns found. Try syncing."}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-6">Campaign Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Objective</TableHead>
                        <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => handleSort("spend")}>
                          Spend<SortIcon field="spend" sortField={sortField} sortDir={sortDir} />
                        </TableHead>
                        <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => handleSort("leads")}>
                          Leads<SortIcon field="leads" sortField={sortField} sortDir={sortDir} />
                        </TableHead>
                        <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => handleSort("cpl")}>
                          CPL<SortIcon field="cpl" sortField={sortField} sortDir={sortDir} />
                        </TableHead>
                        <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => handleSort("ctr")}>
                          CTR<SortIcon field="ctr" sortField={sortField} sortDir={sortDir} />
                        </TableHead>
                        <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => handleSort("convRate")}>
                          Conv. Rate<SortIcon field="convRate" sortField={sortField} sortDir={sortDir} />
                        </TableHead>
                        <TableHead className="pr-6">Ad Sets</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagedCampaigns.map((campaign) => {
                        const ins = insightsMap.get(campaign.id);
                        return (
                          <TableRow key={campaign.id}>
                            <TableCell className="pl-6">
                              <div>
                                <p className="font-medium text-sm">{campaign.name}</p>
                                <p className="text-xs text-muted-foreground font-mono">{campaign.id}</p>
                              </div>
                            </TableCell>
                            <TableCell>
                              <CampaignStatusBadge status={campaign.status} />
                            </TableCell>
                            <TableCell>
                              <span className="text-xs text-muted-foreground">
                                {campaign.objective.replace(/_/g, " ")}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm font-medium">
                                {ins ? formatCurrency(ins.spend, currency) : "—"}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">{ins ? ins.leads.toLocaleString() : "—"}</span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">
                                {ins && ins.cpl > 0 ? formatCurrency(ins.cpl, currency) : "N/A"}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">{ins ? formatPercent(ins.ctr) : "—"}</span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">{ins ? formatPercent(ins.conversionRate) : "—"}</span>
                            </TableCell>
                            <TableCell className="pr-6">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 text-xs"
                                onClick={() =>
                                  navigate(
                                    `/business/ad-accounts/${encodeURIComponent(adAccountId)}__fbAccountId_${fbAccountId}/campaigns/${campaign.id}/adsets`
                                  )
                                }
                              >
                                <Layers className="h-3 w-3" />
                                Ad Sets
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-6 py-3 border-t">
                    <p className="text-xs text-muted-foreground">
                      Page {page} of {totalPages} · {processedCampaigns.length} campaigns
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline" size="sm" className="h-7 px-2"
                        disabled={page === 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline" size="sm" className="h-7 px-2"
                        disabled={page === totalPages}
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

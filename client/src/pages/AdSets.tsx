import { useRoute, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, Search,
} from "lucide-react";
import { useState, useMemo } from "react";
import { toast } from "sonner";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatCurrency(cents: string, currency = "USD"): string {
  if (!cents || cents === "0") return "—";
  const amount = parseInt(cents, 10) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, minimumFractionDigits: 2,
  }).format(amount);
}

type StatusFilter = "ALL" | "ACTIVE" | "PAUSED";
const PAGE_SIZE = 25;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    PAUSED: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    DELETED: "bg-red-100 text-red-800",
    ARCHIVED: "bg-gray-100 text-gray-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? map.ARCHIVED}`}>
      {status}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AdSets() {
  const [, params] = useRoute("/business/ad-accounts/:accountId/campaigns/:campaignId/adsets");
  const [, navigate] = useLocation();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [page, setPage] = useState(1);

  const rawAccountId = params?.accountId ?? "";
  const fbCampaignId = params?.campaignId ?? "";
  const parts = rawAccountId.split("__fbAccountId_");
  const adAccountId = parts[0] ?? "";
  const fbAccountId = parseInt(parts[1] ?? "0", 10);
  const isValidRoute = adAccountId.startsWith("act_") && fbAccountId > 0 && fbCampaignId.length > 0;

  const { data: adSets, isLoading, refetch, isRefetching } =
    trpc.adAnalytics.listAdSets.useQuery(
      { adAccountId, fbAccountId, fbCampaignId },
      { enabled: isValidRoute, staleTime: 8 * 60 * 1000 }
    );

  const syncNow = trpc.adAnalytics.syncNow.useMutation({
    onSuccess: () => { toast.success("Sync complete"); void refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const filtered = useMemo(() => {
    if (!adSets) return [];
    return adSets.filter((a) => {
      if (statusFilter !== "ALL" && a.status !== statusFilter) return false;
      if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [adSets, statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const backToCampaigns = () =>
    navigate(`/business/ad-accounts/${encodeURIComponent(adAccountId)}__fbAccountId_${fbAccountId}/campaigns`);

  if (!isValidRoute) {
    return (
      <DashboardLayout>
        <div className="p-8 text-center text-muted-foreground">Invalid URL. Navigate from Campaigns.</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={backToCampaigns} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Campaigns
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Ad Sets</h1>
              <p className="text-sm text-muted-foreground font-mono">{fbCampaignId}</p>
            </div>
          </div>
          <Button
            variant="outline" size="sm"
            onClick={() => syncNow.mutate({ fbAccountId })}
            disabled={syncNow.isPending || isRefetching}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${(syncNow.isPending || isRefetching) ? "animate-spin" : ""}`} />
            Sync
          </Button>
        </div>

        {/* Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <CardTitle className="text-base">
                Ad Sets
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({filtered.length}{adSets && filtered.length !== adSets.length ? ` of ${adSets.length}` : ""})
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search ad sets…"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    className="h-8 pl-8 w-48 text-sm"
                  />
                </div>
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
              <div className="flex items-center justify-center h-40 text-muted-foreground">
                <RefreshCw className="h-5 w-5 animate-spin mr-2" />
                Loading ad sets…
              </div>
            ) : paged.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">
                {search || statusFilter !== "ALL"
                  ? "No ad sets match your filters."
                  : "No ad sets found. They will appear after the next sync."}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-6">Ad Set Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Daily Budget</TableHead>
                        <TableHead>Lifetime Budget</TableHead>
                        <TableHead>Optimization Goal</TableHead>
                        <TableHead className="pr-6">Billing Event</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paged.map((adSet) => (
                        <TableRow key={adSet.id}>
                          <TableCell className="pl-6">
                            <div>
                              <p className="font-medium text-sm">{adSet.name}</p>
                              <p className="text-xs text-muted-foreground font-mono">{adSet.id}</p>
                            </div>
                          </TableCell>
                          <TableCell><StatusBadge status={adSet.status} /></TableCell>
                          <TableCell>
                            <span className="text-sm">{formatCurrency(adSet.dailyBudget)}</span>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">{formatCurrency(adSet.lifetimeBudget)}</span>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">
                              {adSet.optimizationGoal?.replace(/_/g, " ") || "—"}
                            </span>
                          </TableCell>
                          <TableCell className="pr-6">
                            <span className="text-xs text-muted-foreground">
                              {adSet.billingEvent?.replace(/_/g, " ") || "—"}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-6 py-3 border-t">
                    <p className="text-xs text-muted-foreground">
                      Page {page} of {totalPages} · {filtered.length} ad sets
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

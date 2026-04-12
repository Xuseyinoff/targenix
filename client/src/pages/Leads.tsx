import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  RotateCcw,
  Zap,
} from "lucide-react";
import { useState, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useLeadFilters } from "@/hooks/useLeadFilters";
import { LeadFilters } from "@/components/leads/LeadFilters";
import { LeadCard } from "@/components/leads/LeadCard";
import { LeadsTable } from "@/components/leads/LeadsTable";

const PAGE_SIZE = 20;

export default function Leads() {
  const filters = useLeadFilters();
  const [, setLocation] = useLocation();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncFormId, setSyncFormId] = useState("");
  const [syncPageId, setSyncPageId] = useState("");
  const [syncResult, setSyncResult] = useState<{
    synced: number;
    skipped: number;
    message: string;
  } | null>(null);

  const { data, isLoading, isFetching, refetch } = trpc.leads.list.useQuery(
    {
      limit: PAGE_SIZE,
      offset: filters.page * PAGE_SIZE,
      search: filters.deferredSearch || undefined,
      status:
        filters.statusFilter !== "ALL"
          ? (filters.statusFilter as "PENDING" | "RECEIVED" | "FAILED")
          : undefined,
      platform:
        filters.platformFilter !== "ALL"
          ? (filters.platformFilter as "fb" | "ig")
          : undefined,
      pageId: filters.pageIdFilter !== "ALL" ? filters.pageIdFilter : undefined,
      formId: filters.formIdFilter !== "ALL" ? filters.formIdFilter : undefined,
    },
    { refetchInterval: 5_000 }
  );

  const { data: formsIndex } = trpc.leads.getFormsIndex.useQuery();
  const { data: connections } = trpc.facebook.listConnections.useQuery();

  const pageOptions = useMemo(() => {
    if (!formsIndex) return [];
    const seen = new Set<string>();
    return formsIndex.filter((f) => {
      if (seen.has(f.pageId)) return false;
      seen.add(f.pageId);
      return true;
    });
  }, [formsIndex]);

  const formOptions = useMemo(() => {
    if (!formsIndex) return [];
    if (filters.pageIdFilter === "ALL") return formsIndex;
    return formsIndex.filter((f) => f.pageId === filters.pageIdFilter);
  }, [formsIndex, filters.pageIdFilter]);

  const pollMutation = trpc.leads.pollFromForm.useMutation({
    onSuccess: (result) => {
      setSyncResult(result);
      refetch();
      toast.success(result.message);
    },
    onError: (err) => toast.error(err.message),
  });

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);
  const leads = data?.items ?? [];

  const [retryingIds, setRetryingIds] = useState<Set<number>>(new Set());

  const retryLeadMutation = trpc.leads.retryLead.useMutation({
    onMutate: ({ id }) => setRetryingIds((prev) => new Set(prev).add(id)),
    onSuccess: (_data, { id }) => {
      setRetryingIds((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      toast.success("Lead queued for retry");
      refetch();
    },
    onError: (err, { id }) => {
      setRetryingIds((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      toast.error(err.message);
    },
  });

  const retryAllMutation = trpc.leads.retryAllFailed.useMutation({
    onSuccess: (result) => {
      toast.success(
        result.retried > 0
          ? `${result.retried} failed lead(s) queued for retry`
          : "No failed leads to retry"
      );
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const failedCount = leads.filter(
    (l) =>
      l.dataStatus === "ERROR" ||
      l.deliveryStatus === "FAILED" ||
      l.deliveryStatus === "PARTIAL"
  ).length;

  const handleSync = () => {
    if (!syncFormId.trim()) { toast.error("Please enter a Form ID"); return; }
    if (!syncPageId.trim()) { toast.error("Please select a Page"); return; }
    setSyncResult(null);
    pollMutation.mutate({ formId: syncFormId.trim(), pageId: syncPageId.trim() });
  };

  const handleExportCSV = () => {
    if (leads.length === 0) { toast.error("No leads to export"); return; }
    const header = ["ID", "Name", "Phone", "Email", "Platform", "Page", "Form", "Lead ID", "Data status", "Delivery status", "Created At"];
    const rows = leads.map((l) => [
      l.id,
      l.fullName ?? "",
      l.phone ?? "",
      l.email ?? "",
      (l as any).platform ?? "",
      (l as any).pageName ?? l.pageId,
      (l as any).formName ?? l.formId,
      l.leadgenId,
      l.dataStatus,
      l.deliveryStatus,
      new Date(l.createdAt).toLocaleString(),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${leads.length} leads`);
  };

  const handleSelectId = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  const handleSelectAll = useCallback(
    (select: boolean) => {
      setSelectedIds(select ? new Set(leads.map((l) => l.id)) : new Set());
    },
    [leads]
  );

  // Normalize lead shape for components
  const normalizedLeads = leads.map((l) => ({
    ...l,
    pageName: (l as any).pageName as string | null | undefined,
    formName: (l as any).formName as string | null | undefined,
    platform: (l as any).platform as string | undefined,
    orders: (l as any).orders as { id: number; status: string }[] | undefined,
  }));

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">Leads</h1>
            <p className="text-muted-foreground text-xs mt-0.5 flex items-center gap-1.5">
              {data?.total ?? 0} total
              {isFetching && !isLoading && <RefreshCw className="h-3 w-3 animate-spin" />}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {failedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => retryAllMutation.mutate()}
                disabled={retryAllMutation.isPending}
                className="border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30 h-8 px-2"
                title={`Retry All Failed (${failedCount})`}
              >
                {retryAllMutation.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <RotateCcw className="h-4 w-4" />}
                <span className="hidden sm:inline ml-1.5">Retry ({failedCount})</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              disabled={!leads.length}
              className="h-8 px-2"
              title="Export CSV"
            >
              <FileDown className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Export</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setSyncOpen(true); setSyncResult(null); }}
              className="h-8 px-2"
              title="Sync from Facebook"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Sync</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              className="h-8 px-2"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
            <span className="text-sm font-medium text-primary">{selectedIds.size} selected</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setSelectedIds(new Set())}
            >
              Deselect all
            </Button>
          </div>
        )}

        {/* Filters */}
        <LeadFilters
          filters={filters}
          pageOptions={pageOptions}
          formOptions={formOptions}
          allFormsIndex={formsIndex ?? []}
        />

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : leads.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Zap className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground font-medium">No leads found</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {filters.hasActiveFilters
                  ? "Try adjusting your search or filters."
                  : "Leads will appear here once your Facebook webhook is configured."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="grid gap-1.5 px-0.5 pb-1 md:hidden">
              {normalizedLeads.map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  onClick={() => setLocation(`/leads/${lead.id}`)}
                  onRetry={() => retryLeadMutation.mutate({ id: lead.id })}
                  isRetrying={retryingIds.has(lead.id)}
                />
              ))}
            </div>

            {/* Tablet + Desktop: table */}
            <div className="hidden md:block">
              <LeadsTable
                leads={normalizedLeads}
                onRowClick={(lead) => setLocation(`/leads/${lead.id}`)}
                retryingIds={retryingIds}
                onRetry={(id) => retryLeadMutation.mutate({ id })}
                selectedIds={selectedIds}
                onSelectId={handleSelectId}
                onSelectAll={handleSelectAll}
              />
            </div>
          </>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {filters.page + 1} / {totalPages} &nbsp;·&nbsp; {data?.total ?? 0} leads
            </p>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => filters.setPage(Math.max(0, filters.page - 1))}
                disabled={filters.page === 0}
                className="h-8 w-8 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => filters.setPage(Math.min(totalPages - 1, filters.page + 1))}
                disabled={filters.page >= totalPages - 1}
                className="h-8 w-8 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Sync Dialog */}
      <Dialog
        open={syncOpen}
        onOpenChange={(o) => { setSyncOpen(o); if (!o) setSyncResult(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              Sync Leads from Facebook
            </DialogTitle>
            <DialogDescription>
              Pull all leads from a specific Facebook Lead Form directly via Graph API.
              Duplicates are automatically skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Facebook Page</Label>
              {connections && connections.length > 0 ? (
                <Select value={syncPageId} onValueChange={setSyncPageId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a connected page..." />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((c) => (
                      <SelectItem key={c.id} value={c.pageId}>
                        {c.pageName}{" "}
                        <span className="text-muted-foreground ml-1 text-xs">({c.pageId})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="text-sm text-muted-foreground p-3 rounded-lg border bg-muted/30">
                  No connected pages. Add one in <strong>FB Connections</strong> first.
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Form ID</Label>
              <Input
                placeholder="e.g. 1234567890123456"
                value={syncFormId}
                onChange={(e) => setSyncFormId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Find it in Ads Manager → Lead Ads Forms.
              </p>
            </div>
            {syncResult && (
              <div className="p-3 rounded-lg border bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium text-sm">
                  <CheckCircle2 className="h-4 w-4" />Sync complete
                </div>
                <p className="text-sm text-emerald-600 dark:text-emerald-500 mt-1">
                  {syncResult.message}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSync}
              disabled={pollMutation.isPending || !syncFormId || !syncPageId}
            >
              {pollMutation.isPending
                ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
                : <><Download className="h-4 w-4 mr-2" />Sync Now</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

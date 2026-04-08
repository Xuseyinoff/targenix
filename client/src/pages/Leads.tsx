import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
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
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileDown,
  Loader2,
  Mail,
  Phone,
  RefreshCw,
  RotateCcw,
  Search,
  User,
  Zap,
  Instagram,
  Facebook,
  FileText,
  Filter,
} from "lucide-react";
import { useState, useCallback, useDeferredValue, useMemo } from "react";
import { useLocation } from "wouter";

const PAGE_SIZE = 20;

// ─── Platform badge ───────────────────────────────────────────────────────────

function PlatformIcon({ platform }: { platform?: string }) {
  if (platform === "ig") {
    return (
      <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 shrink-0">
        <Instagram className="h-2.5 w-2.5 text-white" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-600 shrink-0">
      <Facebook className="h-2.5 w-2.5 text-white" />
    </span>
  );
}

function SourceCell({ pageName, formName, platform }: { pageName?: string | null; formName?: string | null; platform?: string }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <PlatformIcon platform={platform} />
        <span className="text-sm font-medium truncate max-w-[160px]">{pageName || "—"}</span>
      </div>
      {formName && (
        <div className="flex items-center gap-1.5 pl-0.5">
          <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate max-w-[160px]">{formName}</span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; icon: React.ElementType; className: string }> = {
    PENDING: { label: "Pending", icon: Clock, className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400" },
    RECEIVED: { label: "Received", icon: CheckCircle2, className: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400" },
    FAILED: { label: "Failed", icon: AlertCircle, className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400" },
  };
  const s = map[status] ?? { label: status, icon: Clock, className: "" };
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${s.className}`}>
      <Icon className="h-3 w-3" />
      {s.label}
    </span>
  );
}

function OrderStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    PENDING: "bg-amber-100 text-amber-700 border-amber-200",
    SENT: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800",
    FAILED: "bg-red-100 text-red-700 border-red-200",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${map[status] ?? ""}`}>
      {status}
    </span>
  );
}

export default function Leads() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [platformFilter, setPlatformFilter] = useState<string>("ALL");
  const [pageIdFilter, setPageIdFilter] = useState<string>("ALL");
  const [formIdFilter, setFormIdFilter] = useState<string>("ALL");
  const [, setLocation] = useLocation();

  const deferredSearch = useDeferredValue(search);

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncFormId, setSyncFormId] = useState("");
  const [syncPageId, setSyncPageId] = useState("");
  const [syncResult, setSyncResult] = useState<{ synced: number; skipped: number; message: string } | null>(null);

  const { data, isLoading, isFetching, refetch } = trpc.leads.list.useQuery(
    {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search: deferredSearch || undefined,
      status: statusFilter !== "ALL" ? (statusFilter as "PENDING" | "RECEIVED" | "FAILED") : undefined,
      platform: platformFilter !== "ALL" ? (platformFilter as "fb" | "ig") : undefined,
      pageId: pageIdFilter !== "ALL" ? pageIdFilter : undefined,
      formId: formIdFilter !== "ALL" ? formIdFilter : undefined,
    },
    { refetchInterval: 5_000 }
  );

  // Forms index for filter dropdowns
  const { data: formsIndex } = trpc.leads.getFormsIndex.useQuery();
  const { data: connections } = trpc.facebook.listConnections.useQuery();

  // Derive page options from forms index
  const pageOptions = useMemo(() => {
    if (!formsIndex) return [];
    const seen = new Set<string>();
    return formsIndex.filter((f) => {
      if (seen.has(f.pageId)) return false;
      seen.add(f.pageId);
      return true;
    });
  }, [formsIndex]);

  // Derive form options filtered by selected page
  const formOptions = useMemo(() => {
    if (!formsIndex) return [];
    if (pageIdFilter === "ALL") return formsIndex;
    return formsIndex.filter((f) => f.pageId === pageIdFilter);
  }, [formsIndex, pageIdFilter]);

  const pollMutation = trpc.leads.pollFromForm.useMutation({
    onSuccess: (result) => {
      setSyncResult(result);
      refetch();
      toast.success(result.message);
    },
    onError: (err) => toast.error(err.message),
  });

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);

  const [retryingIds, setRetryingIds] = useState<Set<number>>(new Set());

  const retryLeadMutation = trpc.leads.retryLead.useMutation({
    onMutate: ({ id }) => setRetryingIds((prev) => new Set(prev).add(id)),
    onSuccess: (_data, { id }) => {
      setRetryingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      toast.success("Lead queued for retry");
      refetch();
    },
    onError: (err, { id }) => {
      setRetryingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      toast.error(err.message);
    },
  });

  const retryAllMutation = trpc.leads.retryAllFailed.useMutation({
    onSuccess: (result) => {
      toast.success(result.retried > 0 ? `${result.retried} failed lead(s) queued for retry` : "No failed leads to retry");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const failedCount = (data?.items ?? []).filter((l) => l.status === "FAILED").length;

  const handleSearchChange = useCallback((val: string) => { setSearch(val); setPage(0); }, []);
  const handleStatusChange = useCallback((val: string) => { setStatusFilter(val); setPage(0); }, []);
  const handlePlatformChange = useCallback((val: string) => { setPlatformFilter(val); setPage(0); }, []);
  const handlePageIdChange = useCallback((val: string) => {
    setPageIdFilter(val);
    setFormIdFilter("ALL"); // reset form when page changes
    setPage(0);
  }, []);
  const handleFormIdChange = useCallback((val: string) => { setFormIdFilter(val); setPage(0); }, []);

  const hasActiveFilters = statusFilter !== "ALL" || platformFilter !== "ALL" || pageIdFilter !== "ALL" || formIdFilter !== "ALL" || search;

  const handleSync = () => {
    if (!syncFormId.trim()) { toast.error("Please enter a Form ID"); return; }
    if (!syncPageId.trim()) { toast.error("Please select a Page"); return; }
    setSyncResult(null);
    pollMutation.mutate({ formId: syncFormId.trim(), pageId: syncPageId.trim() });
  };

  const handleExportCSV = () => {
    const items = data?.items ?? [];
    if (items.length === 0) { toast.error("No leads to export"); return; }
    const header = ["ID", "Name", "Phone", "Email", "Platform", "Page", "Form", "Lead ID", "Status", "Created At"];
    const rows = items.map((l) => [
      l.id,
      l.fullName ?? "",
      l.phone ?? "",
      l.email ?? "",
      (l as any).platform ?? "",
      (l as any).pageName ?? l.pageId,
      (l as any).formName ?? l.formId,
      l.leadgenId,
      l.status,
      new Date(l.createdAt).toLocaleString(),
    ]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${items.length} leads`);
  };

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight truncate">Leads</h1>
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
                {retryAllMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                <span className="hidden sm:inline ml-1.5">Retry ({failedCount})</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={!data?.items?.length} className="h-8 px-2" title="Export CSV">
              <FileDown className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Export</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setSyncOpen(true); setSyncResult(null); }} className="h-8 px-2" title="Sync from Facebook">
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Sync</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} className="h-8 px-2" title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name, phone, email..."
              className="pl-9 h-9"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>

          {/* Platform filter */}
          <Select value={platformFilter} onValueChange={handlePlatformChange}>
            <SelectTrigger className="w-[130px] h-9">
              <SelectValue placeholder="Platform" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Platforms</SelectItem>
              <SelectItem value="fb">
                <span className="flex items-center gap-2"><Facebook className="h-3.5 w-3.5 text-blue-600" />Facebook</span>
              </SelectItem>
              <SelectItem value="ig">
                <span className="flex items-center gap-2"><Instagram className="h-3.5 w-3.5 text-pink-500" />Instagram</span>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Page filter */}
          {pageOptions.length > 0 && (
            <Select value={pageIdFilter} onValueChange={handlePageIdChange}>
              <SelectTrigger className="w-[160px] h-9">
                <SelectValue placeholder="All Pages" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Pages</SelectItem>
                {pageOptions.map((p) => (
                  <SelectItem key={p.pageId} value={p.pageId}>
                    <span className="flex items-center gap-2">
                      <PlatformIcon platform={p.platform} />
                      {p.pageName}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Form filter */}
          {formOptions.length > 0 && (
            <Select value={formIdFilter} onValueChange={handleFormIdChange}>
              <SelectTrigger className="w-[160px] h-9">
                <SelectValue placeholder="All Forms" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Forms</SelectItem>
                {formOptions.map((f) => (
                  <SelectItem key={f.formId} value={f.formId}>{f.formName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Status filter */}
          <Select value={statusFilter} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-[120px] h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Status</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="RECEIVED">Received</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
            </SelectContent>
          </Select>

          {/* Clear filters */}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-muted-foreground"
              onClick={() => {
                setSearch("");
                setStatusFilter("ALL");
                setPlatformFilter("ALL");
                setPageIdFilter("ALL");
                setFormIdFilter("ALL");
                setPage(0);
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (data?.items ?? []).length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Zap className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground font-medium">No leads found</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {hasActiveFilters
                  ? "Try adjusting your search or filters."
                  : "Leads will appear here once your Facebook webhook is configured."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="grid gap-2 md:hidden">
              {(data?.items ?? []).map((lead) => (
                <Card
                  key={lead.id}
                  className="cursor-pointer hover:shadow-sm transition-shadow active:scale-[0.99]"
                  onClick={() => setLocation(`/leads/${lead.id}`)}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start gap-3">
                      <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        <User className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-sm truncate">{lead.fullName || "Unknown"}</p>
                          <StatusBadge status={lead.status} />
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          {lead.phone && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Phone className="h-3 w-3" />{lead.phone}
                            </span>
                          )}
                          {lead.email && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground truncate">
                              <Mail className="h-3 w-3" />{lead.email}
                            </span>
                          )}
                        </div>
                        {/* Source */}
                        <div className="mt-1.5">
                          <SourceCell
                            pageName={(lead as any).pageName ?? lead.pageId}
                            formName={(lead as any).formName ?? lead.formId}
                            platform={(lead as any).platform}
                          />
                        </div>
                        <div className="flex items-center justify-between mt-1.5">
                          <div className="flex flex-wrap gap-1">
                            {(lead as any).orders?.map((order: any) => (
                              <OrderStatusBadge key={order.id} status={order.status} />
                            ))}
                          </div>
                          <span className="text-[11px] text-muted-foreground/60 shrink-0">
                            {new Date(lead.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    {lead.status === "FAILED" && (
                      <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
                          disabled={retryingIds.has(lead.id)}
                          onClick={() => retryLeadMutation.mutate({ id: lead.id })}
                        >
                          {retryingIds.has(lead.id) ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RotateCcw className="h-3 w-3 mr-1" />}
                          Retry
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Desktop: table */}
            <Card className="hidden md:block">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contact</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Source</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Lead Status</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order Status</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[80px]">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.items ?? []).map((lead) => (
                        <tr
                          key={lead.id}
                          className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => setLocation(`/leads/${lead.id}`)}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                <User className="h-3.5 w-3.5 text-primary" />
                              </div>
                              <div>
                                <p className="font-medium">{lead.fullName || "Unknown"}</p>
                                <p className="text-xs text-muted-foreground font-mono">#{lead.id}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="space-y-0.5">
                              {lead.phone && (
                                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <Phone className="h-3 w-3" />{lead.phone}
                                </div>
                              )}
                              {lead.email && (
                                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <Mail className="h-3 w-3" />{lead.email}
                                </div>
                              )}
                              {!lead.phone && !lead.email && <span className="text-xs text-muted-foreground/50">—</span>}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <SourceCell
                              pageName={(lead as any).pageName ?? lead.pageId}
                              formName={(lead as any).formName ?? lead.formId}
                              platform={(lead as any).platform}
                            />
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={lead.status} /></td>
                          <td className="px-4 py-3">
                            {(lead as any).orders?.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {(lead as any).orders.map((order: any) => (
                                  <OrderStatusBadge key={order.id} status={order.status} />
                                ))}
                              </div>
                            ) : <span className="text-xs text-muted-foreground/50">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(lead.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            {lead.status === "FAILED" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                                disabled={retryingIds.has(lead.id)}
                                onClick={() => retryLeadMutation.mutate({ id: lead.id })}
                                title="Retry this lead"
                              >
                                {retryingIds.has(lead.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {page + 1} / {totalPages} &nbsp;·&nbsp; {data?.total ?? 0} leads
            </p>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="h-8 w-8 p-0">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="h-8 w-8 p-0">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Sync Dialog */}
      <Dialog open={syncOpen} onOpenChange={(o) => { setSyncOpen(o); if (!o) setSyncResult(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              Sync Leads from Facebook
            </DialogTitle>
            <DialogDescription>
              Pull all leads from a specific Facebook Lead Form directly via Graph API. Duplicates are automatically skipped.
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
                        {c.pageName} <span className="text-muted-foreground ml-1 text-xs">({c.pageId})</span>
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
              <Input placeholder="e.g. 1234567890123456" value={syncFormId} onChange={(e) => setSyncFormId(e.target.value)} />
              <p className="text-xs text-muted-foreground">Find it in Ads Manager → Lead Ads Forms.</p>
            </div>
            {syncResult && (
              <div className="p-3 rounded-lg border bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium text-sm">
                  <CheckCircle2 className="h-4 w-4" />Sync complete
                </div>
                <p className="text-sm text-emerald-600 dark:text-emerald-500 mt-1">{syncResult.message}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>Cancel</Button>
            <Button onClick={handleSync} disabled={pollMutation.isPending || !syncFormId || !syncPageId}>
              {pollMutation.isPending ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Syncing...</> : <><Download className="h-4 w-4 mr-2" />Sync Now</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

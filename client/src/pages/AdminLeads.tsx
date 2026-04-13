import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Shield, Search, ChevronLeft, ChevronRight, RefreshCw, Users, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";

const PAGE_SIZE = 50;

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    SUCCESS: { label: "SUCCESS", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
    FAILED: { label: "FAILED", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
    PARTIAL: { label: "PARTIAL", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
    PROCESSING: { label: "PROCESSING", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
    PENDING: { label: "PENDING", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
    ENRICHED: { label: "ENRICHED", cls: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300" },
    ERROR: { label: "ERROR", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  };
  const v = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono ${v.cls}`}>{v.label}</span>;
}

export default function AdminLeads() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user && user.role !== "admin") setLocation("/leads");
  }, [user, setLocation]);

  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState<string>("");
  const [pageId, setPageId] = useState("");
  const [formId, setFormId] = useState("");
  const [integrationId, setIntegrationId] = useState<string>("");
  const [onlyRouted, setOnlyRouted] = useState(true);
  const [page, setPage] = useState(0);

  const queryInput = useMemo(() => {
    return {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(userId.trim() ? { userId: parseInt(userId.trim(), 10) } : {}),
      ...(pageId.trim() ? { pageId: pageId.trim() } : {}),
      ...(formId.trim() ? { formId: formId.trim() } : {}),
      ...(integrationId.trim() ? { integrationId: parseInt(integrationId.trim(), 10) } : {}),
      onlyRouted,
    };
  }, [search, userId, pageId, formId, integrationId, onlyRouted, page]);

  const { data, isLoading, isFetching, refetch } = trpc.adminLeads.list.useQuery(queryInput, {
    enabled: user?.role === "admin",
    refetchInterval: 15_000,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  if (!user || user.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-32">
          <div className="text-center">
            <Shield className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">Admin access required</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-7xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Admin Leads</h1>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                <Shield className="h-3 w-3" />
                Admin only
              </span>
            </div>
            <p className="text-muted-foreground text-sm mt-1">
              All users' leads with user/page/form/integration/delivery context
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search lead/user/page/form…"
              className="pl-8"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>

          <div className="relative w-[120px]">
            <Users className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="User ID"
              className="pl-8"
              value={userId}
              onChange={(e) => { setUserId(e.target.value); setPage(0); }}
              type="number"
            />
          </div>

          <Input
            placeholder="pageId"
            className="w-[180px]"
            value={pageId}
            onChange={(e) => { setPageId(e.target.value); setPage(0); }}
          />
          <Input
            placeholder="formId"
            className="w-[180px]"
            value={formId}
            onChange={(e) => { setFormId(e.target.value); setPage(0); }}
          />
          <Input
            placeholder="integrationId"
            className="w-[160px]"
            value={integrationId}
            onChange={(e) => { setIntegrationId(e.target.value); setPage(0); }}
            type="number"
          />

          <Button
            variant={onlyRouted ? "default" : "outline"}
            size="sm"
            onClick={() => { setOnlyRouted((v) => !v); setPage(0); }}
            className="whitespace-nowrap"
          >
            <Route className="h-4 w-4 mr-1.5" />
            only routed
          </Button>
        </div>

        {/* Results */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="py-16 text-center text-muted-foreground">Loading…</div>
            ) : !data?.leads?.length ? (
              <div className="py-16 text-center text-muted-foreground">No leads found</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr>
                      <th className="text-left p-3">Lead</th>
                      <th className="text-left p-3">User</th>
                      <th className="text-left p-3">Page / Form</th>
                      <th className="text-left p-3">Integration</th>
                      <th className="text-left p-3">Deliveries</th>
                      <th className="text-left p-3">Status</th>
                      <th className="text-left p-3">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.leads.map((row) => (
                      <tr key={row.leadId} className="hover:bg-muted/30">
                        <td className="p-3 align-top">
                          <button
                            className="font-mono text-xs underline text-blue-600 dark:text-blue-400"
                            onClick={() => setLocation(`/leads/${row.leadId}`)}
                            title="Open lead detail"
                          >
                            #{row.leadId}
                          </button>
                          <div className="text-xs text-muted-foreground font-mono mt-1">
                            {row.leadgenId}
                          </div>
                          <div className="mt-1 text-xs">
                            {row.fullName ?? "—"} {row.phone ? <span className="text-muted-foreground">· {row.phone}</span> : null}
                          </div>
                        </td>
                        <td className="p-3 align-top">
                          <div className="text-xs font-mono">uid:{row.user.id}</div>
                          <div className="text-xs">{row.user.email ?? row.user.name ?? "—"}</div>
                        </td>
                        <td className="p-3 align-top">
                          <div className="text-xs font-mono">{row.pageId}</div>
                          <div className="text-xs font-mono">{row.formId}</div>
                          {(row.pageName || row.formName) && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {row.pageName ?? "—"} / {row.formName ?? "—"}
                            </div>
                          )}
                        </td>
                        <td className="p-3 align-top">
                          <div className="text-xs font-mono">
                            {row.deliveries.lastIntegrationId != null ? `#${row.deliveries.lastIntegrationId}` : "—"}
                          </div>
                          <div className="text-xs">
                            {row.deliveries.lastIntegrationName ?? "—"}
                          </div>
                          {row.deliveries.lastTargetWebsiteName && (
                            <div className="text-xs text-muted-foreground mt-1">
                              → {row.deliveries.lastTargetWebsiteName}
                            </div>
                          )}
                        </td>
                        <td className="p-3 align-top">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="secondary" className="text-[11px] font-mono">
                              total {row.deliveries.total}
                            </Badge>
                            <Badge variant="secondary" className="text-[11px] font-mono">
                              sent {row.deliveries.sent}
                            </Badge>
                            <Badge variant="secondary" className="text-[11px] font-mono">
                              failed {row.deliveries.failed}
                            </Badge>
                            <Badge variant="secondary" className="text-[11px] font-mono">
                              max att {row.deliveries.attemptsMax}
                            </Badge>
                          </div>
                          {row.deliveries.lastOrderAt && (
                            <div className="text-xs text-muted-foreground mt-1">
                              last: {new Date(row.deliveries.lastOrderAt).toLocaleString()}
                            </div>
                          )}
                        </td>
                        <td className="p-3 align-top">
                          <div className="flex flex-wrap gap-1">
                            {statusBadge(row.dataStatus)}
                            {statusBadge(row.deliveryStatus)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {row.platform.toUpperCase()}
                          </div>
                        </td>
                        <td className="p-3 align-top text-xs text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {totalPages}
              {data ? ` — ${data.total.toLocaleString()} total` : ""}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}


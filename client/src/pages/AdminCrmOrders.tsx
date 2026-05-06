import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  ClipboardList,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  UserCircle,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

const PAGE_SIZE = 50;

const PLATFORM_LABELS: Record<string, string> = {
  sotuvchi: "Sotuvchi.com",
  "100k": "100k.uz",
};

// Canonical status → { label, color classes }
const STATUS_META: Record<string, { label: string; cls: string }> = {
  new:       { label: "Yangi",          cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" },
  accepted:  { label: "Qabul qilindi",  cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  booked:    { label: "Bronlandi",       cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  sent:      { label: "Yuborildi",       cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  delivered: { label: "Yetkazildi",      cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  callback:  { label: "Callback",        cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  cancelled: { label: "Bekor qilindi",   cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  archived:  { label: "Arxivlandi",      cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
};

function CrmStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status)
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        Sync yo'q
      </span>
    );
  const meta = STATUS_META[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s oldin`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m oldin`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}s oldin`;
  return `${Math.floor(diff / 86400)}k oldin`;
}

function extractExternalId(responseData: unknown): string | null {
  if (!responseData || typeof responseData !== "object") return null;
  const d = responseData as Record<string, unknown>;
  const id = d.id ?? (d.data as Record<string, unknown> | undefined)?.id;
  return id != null ? String(id) : null;
}

export default function AdminCrmOrders() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user && user.role !== "admin") setLocation("/leads");
  }, [user, setLocation]);

  const utils = trpc.useUtils();
  const [page, setPage] = useState(0);
  const [platformFilter, setPlatformFilter] = useState<"sotuvchi" | "100k" | "">("");
  const [statusFilter, setStatusFilter] = useState("");
  const [syncBanner, setSyncBanner] = useState<{
    running: boolean;
    rateLimited?: boolean;
    progress?: { current: number; total: number; platform: string } | null;
    message?: string;
    synced?: number;
    errors?: number;
    total?: number;
    aborted?: boolean;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, isFetching } = trpc.adminCrm.listOrders.useQuery(
    {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      platform: platformFilter || undefined,
      crmStatus: statusFilter || undefined,
    },
    { enabled: user?.role === "admin" },
  );

  const { refetch: refetchStatus } = trpc.adminCrm.getSyncStatus.useQuery(undefined, {
    enabled: false,
  });

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => () => stopPolling(), []);

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const { data: s } = await refetchStatus();
      if (!s) return;
      if (!s.running) {
        stopPolling();
        utils.adminCrm.listOrders.invalidate();
        setSyncBanner(
          s.lastResult
            ? { running: false, aborted: s.aborted, ...s.lastResult }
            : { running: false, aborted: s.aborted, message: "Sync tugadi" },
        );
      } else {
        setSyncBanner((prev) => ({
          ...prev,
          running: true,
          progress: s.progress,
          rateLimited: s.progress?.rateLimited ?? false,
        }));
      }
    }, 2000);
  };

  const syncMutation = trpc.adminCrm.syncOrderStatuses.useMutation({
    onSuccess: (result) => {
      if (!result.started && result.message) {
        setSyncBanner({ running: false, message: result.message });
        return;
      }
      setSyncBanner({ running: true, message: "Sync boshlanmoqda..." });
      startPolling();
    },
  });

  const stopMutation = trpc.adminCrm.stopSync.useMutation({
    onSuccess: () => {
      setSyncBanner((prev) => prev ? { ...prev, message: "To'xtatilmoqda..." } : null);
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <ClipboardList className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-semibold">CRM Orderlar</h1>
              <p className="text-sm text-muted-foreground">
                Yetkazilgan lidlar va platforma statuslari
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocation("/admin/crm/accounts")}
            >
              Akkauntlar
            </Button>
            {syncBanner?.running ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={stopMutation.isPending}
                onClick={() => stopMutation.mutate()}
              >
                <Square className="w-3.5 h-3.5 mr-1.5" />
                To'xtatish
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={syncMutation.isPending}
                onClick={() => {
                  setSyncBanner(null);
                  syncMutation.mutate({ platform: platformFilter || undefined });
                }}
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Barchasini sync
              </Button>
            )}
          </div>
        </div>

        {/* Sync banner */}
        {syncBanner && (
          <div className={`rounded-lg border px-4 py-3 text-sm ${
            syncBanner.running
              ? syncBanner.rateLimited
                ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
                : "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300"
              : syncBanner.aborted
                ? "bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300"
                : "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300"
          }`}>
            {syncBanner.running ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-medium">
                    {syncBanner.rateLimited
                      ? "⏸ Rate limit — kutilmoqda..."
                      : <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Sync ishlayapti...</>}
                  </span>
                  {syncBanner.progress && (
                    <span className="text-xs opacity-75">
                      {syncBanner.progress.current} / {syncBanner.progress.total}
                      {" · "}{syncBanner.progress.platform}
                    </span>
                  )}
                </div>
                {syncBanner.progress && syncBanner.progress.total > 0 && (
                  <div className="w-full bg-current/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-current rounded-full transition-all duration-500"
                      style={{ width: `${Math.round((syncBanner.progress.current / syncBanner.progress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span>
                  {syncBanner.aborted
                    ? `⏹ Sync to'xtatildi — ${syncBanner.synced ?? 0} ta yangilandi`
                    : syncBanner.message
                      ? syncBanner.message
                      : `✓ Sync tugadi — ${syncBanner.synced} ta yangilandi${(syncBanner.errors ?? 0) > 0 ? `, ${syncBanner.errors} ta xato` : ""} (jami ${syncBanner.total ?? 0} ta)`}
                </span>
                <button className="ml-4 opacity-60 hover:opacity-100" onClick={() => setSyncBanner(null)}>✕</button>
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          <select
            className="border rounded-md px-3 py-1.5 text-sm bg-background"
            value={platformFilter}
            onChange={(e) => {
              setPlatformFilter(e.target.value as "sotuvchi" | "100k" | "");
              setPage(0);
            }}
          >
            <option value="">Barcha platformalar</option>
            <option value="sotuvchi">Sotuvchi.com</option>
            <option value="100k">100k.uz</option>
          </select>
          <select
            className="border rounded-md px-3 py-1.5 text-sm bg-background"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">Barcha statuslar</option>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <span className="text-sm text-muted-foreground self-center ml-1">
            Jami: {total}
          </span>
        </div>

        {/* Table */}
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-4 py-3 text-left font-medium">Lead</th>
                  <th className="px-4 py-3 text-left font-medium">Platforma</th>
                  <th className="px-4 py-3 text-left font-medium">Order ID</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Integratsiya</th>
                  <th className="px-4 py-3 text-left font-medium">Sync</th>
                  <th className="px-4 py-3 text-left font-medium">Yuborilgan</th>
                </tr>
              </thead>
              <tbody>
                {isLoading || isFetching ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />
                      Yuklanmoqda...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center">
                      <div className="space-y-2">
                        <ClipboardList className="w-8 h-8 mx-auto text-muted-foreground/40" />
                        <p className="text-sm text-muted-foreground">
                          {platformFilter || statusFilter
                            ? "Filtr bo'yicha order topilmadi"
                            : "Hali yetkazilgan order yo'q"}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  items.map((row) => {
                    const externalId = extractExternalId(row.responseData);
                    return (
                      <tr
                        key={row.orderId}
                        className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <UserCircle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="font-medium truncate max-w-[140px]">
                                {row.leadName ?? "—"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {row.leadPhone ?? ""}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-medium">
                            {PLATFORM_LABELS[row.appKey ?? ""] ?? row.appKey ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-muted-foreground">
                            {externalId ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <CrmStatusBadge status={row.crmStatus} />
                            {row.crmRawStatus && row.crmRawStatus !== row.crmStatus && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 font-mono"
                                title="Platformadan kelgan original status"
                              >
                                {row.crmRawStatus}
                              </span>
                            )}
                            {row.isFinal && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500 font-medium">
                                final
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-muted-foreground truncate max-w-[120px] block">
                            {row.integrationName ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-muted-foreground">
                            {timeAgo(row.crmSyncedAt)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-muted-foreground">
                            {row.createdAt
                              ? new Date(row.createdAt).toLocaleDateString("uz-UZ")
                              : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <CardContent className="py-3 border-t flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} / {total}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="w-7 h-7"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="w-7 h-7"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}

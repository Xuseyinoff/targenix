import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Inbox,
  TrendingUp,
  Clock,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const PAGE_SIZE = 50;

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: "green" | "red" | "yellow" | "blue" | "slate";
}) {
  const colors = {
    green:  "text-emerald-600 dark:text-emerald-400",
    red:    "text-red-600 dark:text-red-400",
    yellow: "text-amber-600 dark:text-amber-400",
    blue:   "text-blue-600 dark:text-blue-400",
    slate:  "text-slate-600 dark:text-slate-400",
  };
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className={`text-2xl font-bold ${colors[color ?? "slate"]}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
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

export default function AdminDlq() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user && user.role !== "admin") setLocation("/leads");
  }, [user, setLocation]);

  const [page, setPage] = useState(0);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);

  const utils = trpc.useUtils();

  const { data: stats, isLoading: statsLoading } = trpc.adminDlq.getStats.useQuery(undefined, {
    enabled: user?.role === "admin",
    refetchInterval: 30_000,
  });

  const { data: daily } = trpc.adminDlq.getDailyBreakdown.useQuery(undefined, {
    enabled: user?.role === "admin",
  });

  const { data, isLoading, isFetching } = trpc.adminDlq.listFailed.useQuery(
    { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { enabled: user?.role === "admin" },
  );

  const retryOrder = trpc.adminDlq.retryOrder.useMutation({
    onSuccess: () => {
      void utils.adminDlq.listFailed.invalidate();
      void utils.adminDlq.getStats.invalidate();
    },
  });

  const retryAll = trpc.adminDlq.retryAll.useMutation({
    onSuccess: () => {
      void utils.adminDlq.listFailed.invalidate();
      void utils.adminDlq.getStats.invalidate();
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleRetry = async (orderId: number) => {
    setRetryingId(orderId);
    try {
      await retryOrder.mutateAsync({ orderId });
    } finally {
      setRetryingId(null);
    }
  };

  const handleRetryAll = async () => {
    setRetryingAll(true);
    try {
      await retryAll.mutateAsync();
    } finally {
      setRetryingAll(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-red-500" />
            <div>
              <h1 className="text-xl font-semibold">Yetkazib bo'lmagan orderlar (DLQ)</h1>
              <p className="text-sm text-muted-foreground">
                3 marta urinilgan va muvaffaqiyatsiz tugagan yetkazilmalar
              </p>
            </div>
          </div>
          {total > 0 && (
            <Button
              variant="destructive"
              size="sm"
              disabled={retryingAll}
              onClick={handleRetryAll}
            >
              {retryingAll ? (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              )}
              Hammasini qayta urinish ({total})
            </Button>
          )}
        </div>

        {/* Stats */}
        {!statsLoading && stats && (
          <>
            {/* Period selector tabs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                label="Bugun muvaffaqiyat"
                value={stats.last24h.successRate !== null ? `${stats.last24h.successRate}%` : "—"}
                sub={`${stats.last24h.SENT} SENT / ${stats.last24h.FAILED} FAILED`}
                color={
                  stats.last24h.successRate === null ? "slate"
                  : stats.last24h.successRate >= 90 ? "green"
                  : stats.last24h.successRate >= 70 ? "yellow"
                  : "red"
                }
              />
              <StatCard
                label="7 kunlik muvaffaqiyat"
                value={stats.last7d.successRate !== null ? `${stats.last7d.successRate}%` : "—"}
                sub={`${stats.last7d.SENT} ta yetkazildi`}
                color={
                  stats.last7d.successRate === null ? "slate"
                  : stats.last7d.successRate >= 90 ? "green"
                  : stats.last7d.successRate >= 70 ? "yellow"
                  : "red"
                }
              />
              <StatCard
                label="DLQ (butunlay muvaffaqiyatsiz)"
                value={stats.dlqSize}
                sub="Qayta urinish uchun tugma bosing"
                color={stats.dlqSize > 0 ? "red" : "green"}
              />
              <StatCard
                label="Retry navbatida"
                value={stats.retryableSize}
                sub="Avtomatik qayta uriniladi"
                color={stats.retryableSize > 0 ? "yellow" : "green"}
              />
            </div>

            {/* All-time totals */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                label="Jami SENT (barcha vaqt)"
                value={stats.allTime.SENT.toLocaleString()}
                color="green"
              />
              <StatCard
                label="Jami PENDING"
                value={stats.allTime.PENDING.toLocaleString()}
                color="blue"
              />
              <StatCard
                label="Jami FAILED"
                value={stats.allTime.FAILED.toLocaleString()}
                color={stats.allTime.FAILED > 0 ? "red" : "green"}
              />
            </div>
          </>
        )}

        {/* Daily breakdown table */}
        {daily && daily.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                So'nggi 14 kun (kunlik breakdown)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1.5 px-2 text-left font-medium">Kun</th>
                      <th className="py-1.5 px-2 text-right font-medium text-emerald-600">SENT</th>
                      <th className="py-1.5 px-2 text-right font-medium text-red-600">FAILED</th>
                      <th className="py-1.5 px-2 text-right font-medium text-slate-500">PENDING</th>
                      <th className="py-1.5 px-2 text-right font-medium">% Muvaffaqiyat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...daily].reverse().map((row) => {
                      const total = row.sent + row.failed;
                      const rate = total > 0 ? Math.round((row.sent / total) * 100) : null;
                      return (
                        <tr key={row.day} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="py-1.5 px-2 font-mono">{row.day}</td>
                          <td className="py-1.5 px-2 text-right text-emerald-600 font-medium">{row.sent}</td>
                          <td className="py-1.5 px-2 text-right text-red-600 font-medium">{row.failed}</td>
                          <td className="py-1.5 px-2 text-right text-slate-500">{row.pending}</td>
                          <td className="py-1.5 px-2 text-right">
                            {rate !== null ? (
                              <span className={rate >= 90 ? "text-emerald-600" : rate >= 70 ? "text-amber-600" : "text-red-600"}>
                                {rate}%
                              </span>
                            ) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* DLQ table */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Inbox className="w-4 h-4 text-red-500" />
              Butunlay muvaffaqiyatsiz orderlar
              {total > 0 && (
                <span className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-600 text-[10px] font-bold">
                  {total > 99 ? "99+" : total}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">Lead</th>
                  <th className="px-4 py-2.5 text-left font-medium">Foydalanuvchi</th>
                  <th className="px-4 py-2.5 text-left font-medium">Integratsiya</th>
                  <th className="px-4 py-2.5 text-left font-medium">Platforma</th>
                  <th className="px-4 py-2.5 text-left font-medium">Urinishlar</th>
                  <th className="px-4 py-2.5 text-left font-medium">Oxirgi urinish</th>
                  <th className="px-4 py-2.5 text-left font-medium">Xato</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {isLoading || isFetching ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                      <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />
                      Yuklanmoqda...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center">
                      <div className="space-y-2">
                        <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500/60" />
                        <p className="text-sm text-muted-foreground">
                          DLQ bo'sh — barcha orderlar yetkazilgan
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  items.map((row) => {
                    const errMsg = (() => {
                      try {
                        const d = row.responseData as Record<string, unknown> | null;
                        return (d?.error as string) ?? (d?.message as string) ?? "—";
                      } catch {
                        return "—";
                      }
                    })();
                    return (
                      <tr
                        key={row.orderId}
                        className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                      >
                        <td className="px-4 py-2.5">
                          <p className="font-medium truncate max-w-[120px]">{row.leadName ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">{row.leadPhone ?? ""}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs truncate max-w-[120px]">{row.userName ?? "—"}</p>
                          <p className="text-xs text-muted-foreground truncate max-w-[120px]">{row.userEmail ?? ""}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs truncate max-w-[120px]">{row.integrationName ?? "—"}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                            {row.appKey ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs font-medium text-red-600">
                            {row.attempts} / 3
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {timeAgo(row.lastAttemptAt)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 max-w-[180px]">
                          <p className="text-xs text-red-600 truncate" title={errMsg}>
                            {errMsg}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={retryingId === row.orderId}
                            onClick={() => handleRetry(row.orderId)}
                          >
                            {retryingId === row.orderId ? (
                              <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3 h-3 mr-1" />
                            )}
                            Retry
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <CardContent className="py-3 border-t flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} / {total}
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="icon" className="w-7 h-7"
                  disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button variant="outline" size="icon" className="w-7 h-7"
                  disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
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

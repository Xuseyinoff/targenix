import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { CANONICAL_CRM_STATUS_ORDER } from "@shared/crmStatuses";
import {
  ClipboardList,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  UserCircle,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

const PAGE_SIZE = 50;

const PLATFORM_LABELS: Record<string, string> = {
  sotuvchi: "Sotuvchi.com",
  "100k": "100k.uz",
};

// Badge colors: canonical + legacy strings DB may still carry until re-sync
const STATUS_META: Record<string, { label: string; cls: string }> = {
  new:           { label: "Yangi",              cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" },
  contacted:     { label: "Operator bilan",       cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  in_progress:   { label: "Jarayonda",          cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  unknown:       { label: "Noma’lum (API)",      cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200" },
  success:       { label: "Sotildi",            cls: "bg-teal-100 text-teal-800 dark:bg-teal-900/25 dark:text-teal-300" },
  delivered:     { label: "Yetkazildi",          cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  cancelled:     { label: "Bekor qilindi",      cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  returned:      { label: "Mijoz qaytardi",       cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/25 dark:text-orange-300" },
  not_delivered: { label: "Yetkazilmadi",       cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/25 dark:text-rose-300" },
  trash:         { label: "Trash",              cls: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300" },
  not_sold:      { label: "Sotilmadi",          cls: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  archived:      { label: "Arxivlandi",          cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
  accepted:      { label: "Qabul (legacy)",     cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  filling:       { label: "To‘ldirish (legacy)", cls: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400" },
  order:         { label: "Order (legacy)",     cls: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400" },
  booked:        { label: "Bronlandi",           cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  sent:          { label: "Yuborildi",           cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  preparing:     { label: "Tayyorlanmoqda",      cls: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  recycling:     { label: "Recycling (legacy)",  cls: "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400" },
  on_argue:      { label: "Nizo (legacy)",      cls: "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400" },
  callback:      { label: "Callback",            cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  sold:          { label: "Sotildi (raw)",       cls: "bg-teal-100 text-teal-800 dark:bg-teal-900/25 dark:text-teal-300" },
  client_returned: { label: "Qaytardi (legacy)", cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  not_sold_group: { label: "Guruh sotilmadi", cls: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  request:       { label: "So‘rov (raw)",       cls: "bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300" },
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

const INTEGRATION_COL_W = "8rem"; // fixed column width — tableLayout otherwise expands cell and marquee never triggers

/** One-line label; scrolls left like a ticker when wider than the cell (paused on hover). */
function IntegrationMarquee({ text }: { text: string }) {
  const label = text?.trim() ? text.trim() : "—";
  const outerRef = useRef<HTMLDivElement>(null);
  /** Natural text width probe (truncate can make scrollWidth === clientWidth in some layouts). */
  const probeRef = useRef<HTMLSpanElement>(null);
  const segmentRef = useRef<HTMLSpanElement>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [run, setRun] = useState(false);
  const [sec, setSec] = useState(14);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const layoutMeasure = () => {
    const outer = outerRef.current;
    const probe = probeRef.current;
    const seg = segmentRef.current;
    if (!outer || !probe) return;
    const textW = Math.max(probe.scrollWidth, probe.offsetWidth);
    const available = outer.clientWidth;
    const overflow = reduceMotion ? false : textW > available + 1;

    setRun(overflow);
    const wSrc = overflow && seg ? seg.scrollWidth : textW;
    if (overflow) {
      const pxPerSec = 26;
      setSec(Math.max(8, Math.min(48, wSrc / pxPerSec)));
    }
  };

  useLayoutEffect(() => {
    if (reduceMotion) {
      setRun(false);
      return;
    }

    layoutMeasure();
    const outer = outerRef.current;
    if (!outer) return;

    let raf = 0;
    const scheduleRemeasure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => requestAnimationFrame(layoutMeasure));
    };

    const ro = new ResizeObserver(scheduleRemeasure);
    ro.observe(outer);
    window.addEventListener("resize", scheduleRemeasure);

    scheduleRemeasure();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", scheduleRemeasure);
    };
  }, [label, reduceMotion]);

  const lineCls = "text-xs text-muted-foreground whitespace-nowrap shrink-0";

  return (
    <div ref={outerRef} className="relative min-w-0 w-full overflow-hidden" title={label}>
      {/* Invisible probe: full label width */}
      <span
        ref={probeRef}
        className={`${lineCls} pointer-events-none invisible absolute left-0 top-0 max-w-none whitespace-nowrap`}
        aria-hidden
      >
        {label}
      </span>

      {!run ? (
        <span className={`${lineCls} block truncate max-w-full`}>{label}</span>
      ) : (
        <div
          className="integration-marquee-track inline-flex w-max hover:[animation-play-state:paused]"
          style={{
            animation: `integration-marquee ${sec}s linear infinite`,
            willChange: "transform",
          }}
        >
          <span ref={segmentRef} className={`${lineCls} pr-10`}>
            {label}
          </span>
          <span className={`${lineCls} pr-10`} aria-hidden>
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

export default function AdminCrmOrders() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user && user.role !== "admin") setLocation("/leads");
  }, [user, setLocation]);

  const [page, setPage] = useState(0);
  const [platformFilter, setPlatformFilter] = useState<"sotuvchi" | "100k" | "">("");
  const [statusFilter, setStatusFilter] = useState("");

  const { data, isLoading, isFetching } = trpc.adminCrm.listOrders.useQuery(
    {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      platform: platformFilter || undefined,
      crmStatus: statusFilter || undefined,
    },
    { enabled: user?.role === "admin" },
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <ClipboardList className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">CRM Orderlar</h1>
            <p className="text-sm text-muted-foreground">
              Yetkazilgan lidlar va platforma statuslari
            </p>
          </div>
        </div>

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
            {CANONICAL_CRM_STATUS_ORDER.map((k) => (
              <option key={k} value={k}>
                {STATUS_META[k]?.label ?? k}
              </option>
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
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th
                    className="px-4 py-3 text-left font-medium overflow-hidden min-w-0 box-border"
                    style={{ width: INTEGRATION_COL_W, maxWidth: INTEGRATION_COL_W }}
                  >
                    Integratsiya
                  </th>
                  <th className="px-4 py-3 text-left font-medium">Sync</th>
                  <th className="px-4 py-3 text-left font-medium">Yuborilgan</th>
                </tr>
              </thead>
              <tbody>
                {isLoading || isFetching ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                      <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />
                      Yuklanmoqda...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center">
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
                          <div className="min-w-0">
                            <p className="font-medium truncate max-w-[140px]">
                              {PLATFORM_LABELS[row.appKey ?? ""] ?? row.appKey ?? "—"}
                            </p>
                            <p className="font-mono text-xs text-muted-foreground truncate max-w-[140px]">
                              {externalId ?? "—"}
                            </p>
                          </div>
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
                        <td
                          className="px-4 py-3 align-top overflow-hidden min-w-0 box-border"
                          style={{ width: INTEGRATION_COL_W, maxWidth: INTEGRATION_COL_W }}
                        >
                          <IntegrationMarquee text={row.integrationName ?? "—"} />
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

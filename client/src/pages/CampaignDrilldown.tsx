/**
 * CampaignDrilldown — per-campaign × per-affiliate drill-down.
 *
 * Reached by clicking a row on /insights when groupBy="campaign". URL shape:
 *   /insights/campaign/:campaignId?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Inherits the date range from the parent page via query string. The
 * date picker on this page writes back to the query string so the URL
 * is shareable (refresh / open-in-new-tab preserves the view).
 *
 * Three sections below the header:
 *   1. Campaign KPI strip — total leads / spend / revenue, with a
 *      "partial" footnote when any affiliate has uncaptured payout.
 *   2. Per-affiliate table — Sent / Delivered / In-flight / Rejected /
 *      Archived / Unsynced / Revenue / Status badge. Revenue cell renders
 *      "—" with a tooltip when payout is not yet captured.
 *   3. Status distribution count strip — labeled counts across all
 *      affiliates for the campaign, comma-separated.
 *
 * Money formatting matches Insights.tsx: amounts arrive in the smallest
 * unit of the row's currency (UZS so'm 1:1, USD cents 100:1).
 */
import { useMemo } from "react";
import { useRoute, useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, BarChart3, Loader2 } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

// ── Date range presets (mirrors Insights.tsx for consistency) ────────────────
type PresetKey = "today" | "yesterday" | "last_7d" | "last_30d";

function defaultRange(): { start: string; end: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
  return { start: sevenDaysAgo.toISOString().slice(0, 10), end: todayStr };
}

function rangeFor(preset: PresetKey): { start: string; end: string; label: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dayShift = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  switch (preset) {
    case "today":     return { start: todayStr,     end: todayStr,    label: "Today" };
    case "yesterday": return { start: dayShift(1),  end: dayShift(1), label: "Yesterday" };
    case "last_7d":   return { start: dayShift(6),  end: todayStr,    label: "Last 7 days" };
    case "last_30d":  return { start: dayShift(29), end: todayStr,    label: "Last 30 days" };
  }
}

function formatMoney(amountMinor: number, currency: string): string {
  if (currency === "UZS") {
    return `${Math.round(amountMinor).toLocaleString("en-US")} UZS`;
  }
  return `$${(amountMinor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// Parse `?start=...&end=...` from wouter's useSearch (which returns the part
// after `?` with no leading `?`). Falls back to the 7-day default when the
// caller arrived without query params (e.g. typed the URL by hand).
function readRangeFromSearch(search: string): { start: string; end: string } {
  const params = new URLSearchParams(search);
  const start = params.get("start");
  const end = params.get("end");
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start) && end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { start, end };
  }
  return defaultRange();
}

export default function CampaignDrilldown() {
  const [, params] = useRoute("/insights/campaign/:campaignId");
  const [, setLocation] = useLocation();
  const search = useSearch();

  const range = useMemo(() => readRangeFromSearch(search), [search]);
  const campaignId = useMemo(
    () => (params?.campaignId ? decodeURIComponent(params.campaignId) : ""),
    [params?.campaignId],
  );

  const { data, isLoading, isError, refetch } = trpc.insights.getCampaignAffiliateBreakdown.useQuery(
    { campaignId, start: range.start, end: range.end },
    { enabled: campaignId.length > 0, staleTime: 60_000 },
  );

  function setRange(preset: PresetKey) {
    const r = rangeFor(preset);
    setLocation(
      `/insights/campaign/${encodeURIComponent(campaignId)}?start=${r.start}&end=${r.end}`,
      { replace: true },
    );
  }

  const isEmpty = !isLoading && !isError && (data?.campaign.totalLeads ?? 0) === 0;

  return (
    <DashboardLayout>
      <div className="space-y-4 p-4 lg:p-6 max-w-[1400px] mx-auto">
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setLocation(`/insights?start=${range.start}&end=${range.end}`)}
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold flex items-center gap-2">
                <BarChart3 className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" />
                <span
                  className="truncate"
                  title={data?.campaign.name || campaignId}
                >
                  {data?.campaign.name || campaignId || "Campaign"}
                </span>
              </h1>
              <p className="text-sm text-muted-foreground">
                {range.start} → {range.end}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {(["today", "yesterday", "last_7d", "last_30d"] as const).map((p) => {
              const r = rangeFor(p);
              const active = r.start === range.start && r.end === range.end;
              return (
                <Button
                  key={p}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => setRange(p)}
                >
                  {r.label}
                </Button>
              );
            })}
          </div>
        </div>

        {/* ── Campaign KPI strip ───────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            {isLoading ? (
              <div className="flex h-16 items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : isError ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <p className="text-sm text-red-600 dark:text-red-400">
                  Ma'lumot yuklanmadi
                </p>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Qayta urinib ko'ring
                </Button>
              </div>
            ) : isEmpty ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                Bu davrda kampaniya bo'yicha lid topilmadi. Sana oralig'ini o'zgartiring.
              </div>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
                <Kpi label="Leads" value={formatNumber(data!.campaign.totalLeads)} />
                <Kpi
                  label="Spend"
                  value={formatMoney(
                    data!.campaign.totalSpend.amountMinor,
                    data!.campaign.totalSpend.currency,
                  )}
                />
                <Kpi
                  label="Revenue"
                  value={formatMoney(
                    data!.campaign.totalRevenue.amountMinor,
                    data!.campaign.totalRevenue.currency,
                  )}
                  valueClass={
                    data!.campaign.totalRevenue.amountMinor > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : undefined
                  }
                />
                {data!.campaign.totalRevenueNote === "partial" && (
                  <p
                    className="text-xs text-amber-600 dark:text-amber-400 basis-full"
                    title="Ba'zi affiliate uchun payout hali kuzatilmaydi (masalan 100k.uz). Phase 3.1 da qo'shiladi."
                  >
                    * Qisman — ba'zi affiliate payouti hali kuzatilmaydi
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Per-affiliate table ─────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Affiliate bo'yicha</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex h-24 items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : !data || data.perAffiliate.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Hech qanday affiliate'ga lid yuborilmagan.
              </div>
            ) : (
              <>
                {/* Desktop / wide: full table */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-2 pr-3">Affiliate</th>
                        <th className="text-right py-2 px-3">Sent</th>
                        <th className="text-right py-2 px-3">Delivered</th>
                        <th className="text-right py-2 px-3" title="In-flight: order is past 'new' but not yet final">In-flight</th>
                        <th className="text-right py-2 px-3">Rejected</th>
                        <th className="text-right py-2 px-3">Archived</th>
                        <th className="text-right py-2 px-3">Unsynced</th>
                        <th className="text-right py-2 px-3">Revenue</th>
                        <th className="text-right py-2 px-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.perAffiliate.map((a) => (
                        <tr key={a.appKey} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="py-2 pr-3 font-medium truncate max-w-[200px]" title={a.affiliateName}>
                            {a.affiliateName}
                          </td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(a.ordersSent)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(a.delivered)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(a.inFlight)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(a.rejected)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{formatNumber(a.archived)}</td>
                          <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                            {formatNumber(a.unsynced)}
                          </td>
                          <td className="text-right py-2 px-3 tabular-nums">
                            {a.revenue ? (
                              formatMoney(a.revenue.amountMinor, a.revenue.currency)
                            ) : (
                              <span
                                className="text-muted-foreground"
                                title="Payout kuzatish kelajakda qo'shiladi"
                              >—</span>
                            )}
                          </td>
                          <td className="text-right py-2 px-3">
                            <SyncBadge status={a.syncStatus} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: stacked cards */}
                <div className="sm:hidden space-y-2">
                  {data.perAffiliate.map((a) => (
                    <div key={a.appKey} className="rounded-md border p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium truncate" title={a.affiliateName}>
                          {a.affiliateName}
                        </div>
                        <SyncBadge status={a.syncStatus} />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
                        <MobileStat label="Sent" value={formatNumber(a.ordersSent)} />
                        <MobileStat label="Delivered" value={formatNumber(a.delivered)} />
                        <MobileStat label="In-flight" value={formatNumber(a.inFlight)} />
                        <MobileStat label="Rejected" value={formatNumber(a.rejected)} />
                        <MobileStat label="Archived" value={formatNumber(a.archived)} />
                        <MobileStat label="Unsynced" value={formatNumber(a.unsynced)} />
                      </div>
                      <div className="text-sm">
                        <span className="text-muted-foreground">Revenue: </span>
                        {a.revenue ? (
                          <span className="font-semibold">
                            {formatMoney(a.revenue.amountMinor, a.revenue.currency)}
                          </span>
                        ) : (
                          <span
                            className="text-muted-foreground"
                            title="Payout kuzatish kelajakda qo'shiladi"
                          >—</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Status distribution count strip ─────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status taqsimoti</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex h-12 items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : !data || data.statusDistribution.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Statuslar topilmadi.
              </p>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm tabular-nums">
                {data.statusDistribution.map((s, i) => (
                  <span key={`${s.crmRawStatus}-${i}`} className="whitespace-nowrap">
                    <span className="text-muted-foreground">{s.crmRawStatus}</span>
                    {" "}
                    <span className="font-semibold">{formatNumber(s.count)}</span>
                    {i < data.statusDistribution.length - 1 && (
                      <span className="text-muted-foreground/50 ml-2">·</span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

// ── Sync badge ──────────────────────────────────────────────────────────────
function SyncBadge({ status }: { status: "live" | "pending" | "no-sync" }) {
  if (status === "live") {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400">
        Live
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge
        className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400"
        title="Payout kuzatish kelajakda qo'shiladi (Phase 3.1)"
      >
        Payout kutilmoqda
      </Badge>
    );
  }
  return (
    <Badge
      className="bg-gray-100 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-400"
      title="CRM sync hali ulanmagan"
    >
      Sync yo'q
    </Badge>
  );
}

// ── KPI block (campaign-wide stripe) ───────────────────────────────────────
function Kpi({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={"text-xl sm:text-2xl font-semibold tabular-nums " + (valueClass ?? "")}>
        {value}
      </span>
    </div>
  );
}

// ── Compact stat used inside mobile affiliate cards ────────────────────────
function MobileStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}

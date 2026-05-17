import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Filter,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { FilterBuilderSheet } from "@/components/FilterBuilder";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";

function routingBadgeClass(isActive: boolean) {
  if (!isActive) {
    return "border-border bg-muted/70 text-muted-foreground";
  }
  return "bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950 dark:text-orange-400";
}

function routingIconBg(isActive: boolean) {
  if (!isActive) {
    return "bg-muted text-muted-foreground";
  }
  return "bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400";
}

export default function Integrations() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const t = useT();
  const { data: integrations, isLoading } = trpc.integrations.list.useQuery();
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;
  const [testResult, setTestResult] = useState<{
    integrationId: number;
    integrationName: string;
    success: boolean;
    responseData: unknown;
    error?: string;
    durationMs: number;
  } | null>(null);
  const [filterIntegrationId, setFilterIntegrationId] = useState<number | null>(null);

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMutation = trpc.integrations.toggle.useMutation({
    onSuccess: () => utils.integrations.list.invalidate(),
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.integrations.delete.useMutation({
    onSuccess: () => {
      toast.success(t("integrations.integrationDeleted"));
      utils.integrations.list.invalidate();
      setDeleteId(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const routingIntegrations = useMemo(
    () => (integrations ?? []).filter((i) => i.type === "LEAD_ROUTING"),
    [integrations],
  );

  const testLeadMutation = trpc.integrations.testLead.useMutation({
    onSuccess: (data, variables) => {
      const integration = routingIntegrations.find((i) => i.id === variables.id);
      setTestResult({
        integrationId: variables.id,
        integrationName: integration?.name ?? t("integrations.title"),
        success: data.success,
        responseData: data.responseData,
        error: data.error,
        durationMs: data.durationMs,
      });
    },
    onError: (err) => toast.error(t("integrations.testFailed", { message: err.message })),
  });

  const filteredIntegrations = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return routingIntegrations.filter((i) => {
      if (filterStatus === "ACTIVE" && !i.isActive) return false;
      if (filterStatus === "INACTIVE" && i.isActive) return false;
      if (!q) return true;
      const config = i.config as Record<string, unknown>;
      return (
        i.name.toLowerCase().includes(q) ||
        String(i.pageName ?? "").toLowerCase().includes(q) ||
        String(i.formName ?? "").toLowerCase().includes(q) ||
        String((i as { targetWebsiteName?: string }).targetWebsiteName ?? config.targetWebsiteName ?? "").toLowerCase().includes(q)
      );
    });
  }, [routingIntegrations, searchQuery, filterStatus]);

  // Reset to page 1 when filters change
  useEffect(() => { setCurrentPage(1); }, [searchQuery, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(filteredIntegrations.length / PAGE_SIZE));
  const pagedIntegrations = filteredIntegrations.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <DashboardLayout>
      {/* ── Sticky page header (Wapi pattern) ── */}
      <div className="sticky top-16 z-30 -mx-6 -mt-6 mb-5 bg-background/85 backdrop-blur-md border-b border-slate-200/70 dark:border-border">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-end justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-primary">{t("integrations.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {t("integrations.subtitle")}
            </p>
          </div>
          <Button
            onClick={() => navigate("/integrations/new-v2")}
            title={t("integrations.newLeadRouting")}
            className="wapi-button-hover rounded-full h-10 px-4 bg-primary hover:bg-primary/90 text-primary-foreground font-medium shrink-0"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            {t("integrations.leadRouting")}
          </Button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto space-y-5 pb-16">
        {/* Search & status filters card — when at least one Lead Routing rule exists */}
        {!isLoading && routingIntegrations.length > 0 && (
          <div className="bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-4 space-y-3">
            {/* Search input — Wapi big rounded */}
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-11 pr-11 h-11 rounded-xl text-sm bg-slate-50/60 dark:bg-muted/30 border-transparent focus-visible:bg-background focus-visible:border-input"
                placeholder={t("integrations.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setSearchQuery("")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Filter pills — Wapi rounded-full */}
              <div className="flex items-center gap-1 rounded-full border border-slate-200/70 dark:border-border bg-slate-50/40 dark:bg-muted/20 p-1">
                {(["ALL", "ACTIVE", "INACTIVE"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFilterStatus(s)}
                    className={cn(
                      "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all",
                      filterStatus === s
                        ? "bg-white dark:bg-card shadow-sm text-foreground ring-1 ring-slate-200/80 dark:ring-border/50"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/50 dark:hover:bg-muted/40"
                    )}
                  >
                    {s === "ALL" ? t("integrations.allStatus") : s === "ACTIVE" ? t("integrations.active") : t("integrations.inactive")}
                  </button>
                ))}
              </div>
              {/* Count chip */}
              <div className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 dark:bg-muted text-xs">
                <span className="font-bold tabular-nums">{filteredIntegrations.length}</span>
                {filteredIntegrations.length !== routingIntegrations.length && (
                  <span className="text-muted-foreground">of {routingIntegrations.length}</span>
                )}
                <span className="text-muted-foreground">routing rule{filteredIntegrations.length === 1 ? "" : "s"}</span>
              </div>
            </div>
          </div>
        )}

        {/* Quick-start cards when empty (Wapi onboarding) */}
        {!isLoading && routingIntegrations.length === 0 && (
          <button
            type="button"
            onClick={() => navigate("/integrations/new-v2")}
            className="wapi-card-hover w-full max-w-md mx-auto flex flex-col items-center text-center py-10 px-6 gap-3 bg-white dark:bg-card border border-dashed border-slate-300 dark:border-border rounded-2xl hover:border-emerald-300 transition-colors"
          >
            <div className="h-14 w-14 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/40 flex items-center justify-center">
              <Zap className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="font-bold text-base">{t("integrations.createRoutingTitle")}</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[280px] leading-relaxed">
                {t("integrations.createRoutingBody")}
              </p>
            </div>
            <span className="wapi-button-hover inline-flex items-center gap-1.5 mt-2 h-10 px-4 rounded-full bg-primary text-primary-foreground text-sm font-medium">
              {t("integrations.getStarted")}
              <ArrowRight className="h-4 w-4" />
            </span>
          </button>
        )}

        {/* Integration list */}
        {isLoading ? (
          <div className="bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading integrations…</p>
            </div>
          </div>
        ) : filteredIntegrations.length === 0 && routingIntegrations.length > 0 ? (
          <div className="bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl flex flex-col items-center justify-center py-14 text-center gap-3">
            <div className="h-14 w-14 rounded-2xl bg-slate-50 dark:bg-muted/30 border border-slate-100 dark:border-border flex items-center justify-center">
              <Search className="h-6 w-6 text-slate-400 dark:text-muted-foreground/60" />
            </div>
            <div>
              <p className="text-sm font-semibold">{t("integrations.noMatchTitle")}</p>
              <p className="text-xs text-muted-foreground mt-1">{t("integrations.noMatchBody")}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-8 rounded-full"
              onClick={() => { setSearchQuery(""); setFilterStatus("ALL"); }}
            >
              {t("integrations.clearFilters")}
            </Button>
          </div>
        ) : (
          routingIntegrations.length > 0 && (
            <div className="grid gap-3">
              {pagedIntegrations.map((integration) => {
                const config = integration.config as Record<string, unknown>;
                const isExpanded = expandedIds.has(integration.id);
                const varFields = (config.variableFields as Record<string, string> | undefined) ?? undefined;
                const varEntries = varFields ? Object.entries(varFields).filter(([, v]) => v) : [];

                const targetWebsiteName =
                  (integration as { targetWebsiteName?: string }).targetWebsiteName ??
                  (typeof config.targetWebsiteName === "string" ? config.targetWebsiteName : "");

                const summaryLine = [
                  integration.formName,
                  `→ ${targetWebsiteName.trim() || "—"}`,
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <div
                    key={integration.id}
                    className={cn(
                      "wapi-card-hover overflow-hidden rounded-2xl border bg-white dark:bg-card transition-colors group",
                      integration.isActive
                        ? "border-slate-200/70 dark:border-border"
                        : "border-slate-200/50 bg-slate-50/30 dark:bg-muted/15 dark:border-border/60"
                    )}
                  >
                    <div
                      className={cn(
                        "flex min-h-[4.25rem] items-stretch",
                        !integration.isActive && "opacity-90"
                      )}
                    >
                      <button
                        type="button"
                        id={`integration-trigger-${integration.id}`}
                        className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4 text-left transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15"
                        onClick={() => toggleExpand(integration.id)}
                        aria-expanded={isExpanded}
                        aria-controls={`integration-panel-${integration.id}`}
                        aria-label={`${integration.name}, Lead routing${
                          integration.isActive ? ", active" : ", turned off"
                        }. Show details.`}
                      >
                        <div
                          className={cn(
                            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-200 group-hover:scale-105",
                            integration.isActive
                              ? "bg-gradient-to-br from-orange-400 to-orange-500 shadow-sm ring-2 ring-orange-100 dark:ring-orange-950/40"
                              : "bg-slate-100 dark:bg-muted ring-2 ring-background"
                          )}
                        >
                          <Zap
                            className={cn(
                              "h-5 w-5",
                              integration.isActive ? "text-white" : "text-slate-400"
                            )}
                            strokeWidth={2.2}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <p
                              className={cn(
                                "min-w-0 flex-1 truncate text-sm font-bold leading-tight transition-colors",
                                integration.isActive
                                  ? "text-foreground group-hover:text-emerald-700 dark:group-hover:text-emerald-400"
                                  : "text-foreground/70"
                              )}
                            >
                              {integration.name}
                            </p>
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest",
                                integration.isActive
                                  ? "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900/40"
                                  : "bg-slate-100 text-slate-500 border-slate-200 dark:bg-muted dark:text-muted-foreground dark:border-border"
                              )}
                            >
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full",
                                  integration.isActive ? "bg-orange-500" : "bg-slate-400"
                                )}
                              />
                              {t("integrations.routing")}
                            </span>
                          </div>
                          <p
                            className={cn(
                              "mt-1 truncate text-xs leading-tight",
                              integration.isActive
                                ? "text-muted-foreground"
                                : "text-muted-foreground/70"
                            )}
                          >
                            {summaryLine}
                          </p>
                        </div>
                        <ChevronDown
                          className={cn(
                            "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
                            isExpanded && "rotate-180"
                          )}
                        />
                      </button>

                      <div
                        className="flex shrink-0 items-center gap-1 border-l border-slate-200/70 dark:border-border px-2 py-2"
                        onClick={(e) => e.stopPropagation()}
                        role="presentation"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-primary hover:bg-emerald-50 dark:hover:bg-emerald-950/30 h-9 w-9 rounded-lg"
                          title={t("integrations.editRouting")}
                          onClick={() => navigate(`/integrations/edit-v2/${integration.id}`)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 h-9 w-9 rounded-lg"
                          title={t("integrations.cloneTooltip")}
                          onClick={() =>
                            navigate(`/integrations/new-v2?cloneFrom=${integration.id}`)
                          }
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-primary hover:bg-emerald-50 dark:hover:bg-emerald-950/30 h-9 w-9 rounded-lg"
                          title={t("integrations.testLead")}
                          disabled={
                            testLeadMutation.isPending &&
                            testLeadMutation.variables?.id === integration.id
                          }
                          onClick={() => testLeadMutation.mutate({ id: integration.id })}
                        >
                          {testLeadMutation.isPending &&
                          testLeadMutation.variables?.id === integration.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <FlaskConical className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Switch
                          className="mx-1 shrink-0 data-[state=checked]:bg-emerald-500"
                          checked={integration.isActive}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: integration.id, isActive: checked })
                          }
                        />
                      </div>
                    </div>

                    {isExpanded && (
                      <div
                        id={`integration-panel-${integration.id}`}
                        role="region"
                        aria-labelledby={`integration-trigger-${integration.id}`}
                        className="bg-slate-50/40 dark:bg-muted/15 border-t border-slate-200/70 dark:border-border px-4 pb-4"
                      >
                          <div className="pt-3 space-y-2">
                            <div className="text-xs text-muted-foreground">
                              {t("integrations.page")}: <span className="font-medium text-foreground">{String(integration.pageName ?? "—")}</span>
                              {" · "}
                              {t("integrations.form")}: <span className="font-medium text-foreground">{String(integration.formName ?? "—")}</span>
                            </div>
                            {targetWebsiteName.trim() !== "" && (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                <span>→</span>
                                <span className="font-medium text-foreground">{targetWebsiteName}</span>
                              </div>
                            )}
                            {varEntries.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {varEntries.map(([key, val]) => (
                                  <span
                                    key={key}
                                    className="inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                                  >
                                    <span className="text-muted-foreground">{key}:</span>
                                    <span className="font-semibold text-foreground">{val}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground/50">
                              {t("integrations.added", { date: new Date(integration.createdAt).toLocaleDateString() })}
                            </p>

                          {/* Action buttons (Wapi pill style) */}
                          <div className="flex flex-wrap items-center gap-2 pt-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="wapi-button-hover h-9 text-xs rounded-full font-medium"
                              title={t("integrations.testLead")}
                              disabled={testLeadMutation.isPending && testLeadMutation.variables?.id === integration.id}
                              onClick={() => testLeadMutation.mutate({ id: integration.id })}
                            >
                              {testLeadMutation.isPending && testLeadMutation.variables?.id === integration.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {t("integrations.testLeadButton")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="wapi-button-hover h-9 text-xs rounded-full font-medium"
                              title={t("integrations.editRouting")}
                              onClick={() => navigate(`/integrations/edit-v2/${integration.id}`)}
                            >
                              <Pencil className="mr-1.5 h-3.5 w-3.5" />
                              {t("integrations.edit")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="wapi-button-hover h-9 text-xs rounded-full font-medium text-indigo-600 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 dark:border-indigo-800 dark:hover:bg-indigo-950/30"
                              title={t("integrations.cloneTooltip")}
                              onClick={() =>
                                navigate(`/integrations/new-v2?cloneFrom=${integration.id}`)
                              }
                            >
                              <Copy className="mr-1.5 h-3.5 w-3.5" />
                              {t("integrations.clone")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="wapi-button-hover h-9 text-xs rounded-full font-medium text-violet-600 border-violet-200 hover:bg-violet-50 hover:text-violet-700 dark:border-violet-800 dark:hover:bg-violet-950/30"
                              title="Filtr sozlamalari"
                              onClick={() => setFilterIntegrationId(integration.id)}
                            >
                              <Filter className="mr-1.5 h-3.5 w-3.5" />
                              Filtr
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="wapi-button-hover h-9 text-xs rounded-full font-medium text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
                              onClick={() => setDeleteId(integration.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                              {t("integrations.delete")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Pagination — Wapi pill style */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl px-4 py-3 mt-2">
                  <p className="text-muted-foreground text-xs">
                    {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredIntegrations.length)} of {filteredIntegrations.length}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0 rounded-full"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => p - 1)}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <div className="h-8 min-w-[80px] px-3 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold tabular-nums">
                      {currentPage} / {totalPages}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0 rounded-full"
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage((p) => p + 1)}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        )}
      </div>

      {/* Test Lead Result Modal */}
      <Dialog open={testResult !== null} onOpenChange={() => setTestResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {testResult?.success ? (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              ) : (
                <XCircle className="h-5 w-5 text-red-500" />
              )}
              {t("integrations.testModalTitle", { name: testResult?.integrationName ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {t("integrations.testModalSubtitle")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className={`rounded-lg border p-3 ${
              testResult?.success
                ? "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800"
                : "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800"
            }`}>
              <p className={`text-sm font-semibold ${
                testResult?.success ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
              }`}>
                {testResult?.success ? t("integrations.success") : t("integrations.failed")}
              </p>
              {testResult?.durationMs !== undefined && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("integrations.time", { seconds: (testResult.durationMs / 1000).toFixed(2) })}
                </p>
              )}
            </div>
            {testResult?.error && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800 p-3">
                <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1">{t("integrations.error")}</p>
                <p className="text-xs text-red-600 dark:text-red-300 font-mono break-all">{testResult.error}</p>
              </div>
            )}
            {testResult?.responseData !== null && testResult?.responseData !== undefined && (
              <div className="rounded-lg border bg-muted/50 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t("integrations.response")}</p>
                <pre className="text-xs font-mono break-all whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {typeof testResult.responseData === "string"
                    ? testResult.responseData
                    : JSON.stringify(testResult.responseData, null, 2)}
                </pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestResult(null)}>{t("integrations.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Filter Builder Sheet */}
      {filterIntegrationId !== null && (() => {
        const fi = routingIntegrations.find((i) => i.id === filterIntegrationId);
        if (!fi) return null;
        const destNames: Record<number, string> = {};
        const destIds = (fi as { destinationIds?: number[] }).destinationIds ?? [];
        destIds.forEach((id) => {
          destNames[id] = (fi as { targetWebsiteName?: string }).targetWebsiteName ?? `#${id}`;
        });
        return (
          <FilterBuilderSheet
            open={true}
            onClose={() => setFilterIntegrationId(null)}
            integrationId={fi.id}
            integrationName={fi.name}
            integrationConfig={(fi.config ?? {}) as Record<string, unknown>}
            destinationNames={destNames}
          />
        );
      })()}

      {/* Delete Confirm */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("integrations.deleteDialogTitle")}</DialogTitle>
            <DialogDescription>{t("integrations.deleteDialogBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate({ id: deleteId })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

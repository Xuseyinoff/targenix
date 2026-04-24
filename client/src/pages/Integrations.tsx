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
      <div className="max-w-4xl space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">{t("integrations.title")}</h1>
            <p className="text-muted-foreground mt-0.5 hidden text-xs sm:block">
              {t("integrations.subtitle")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => navigate("/integrations/new-routing")}
              title="Classic wizard"
            >
              <span className="hidden sm:inline text-xs">Classic</span>
            </Button>
            <Button
              size="sm"
              className="h-8 px-2"
              onClick={() => navigate("/integrations/new-v2")}
              title={t("integrations.newLeadRouting")}
            >
              <Plus className="h-4 w-4" />
              <span className="ml-1.5 hidden sm:inline">{t("integrations.leadRouting")}</span>
            </Button>
          </div>
        </div>

        {/* Search & status filters — when at least one Lead Routing rule exists */}
        {!isLoading && routingIntegrations.length > 0 && (
          <div className="space-y-2">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-9 pr-9 h-9 text-sm bg-background"
                placeholder={t("integrations.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setSearchQuery("")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted/50 p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {(["ALL", "ACTIVE", "INACTIVE"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFilterStatus(s)}
                    className={cn(
                      "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-all",
                      filterStatus === s
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {s === "ALL" ? t("integrations.allStatus") : s === "ACTIVE" ? t("integrations.active") : t("integrations.inactive")}
                  </button>
                ))}
              </div>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                {filteredIntegrations.length === routingIntegrations.length
                  ? t("integrations.routingRules", { count: routingIntegrations.length })
                  : t("integrations.routingRulesOf", { filtered: filteredIntegrations.length, total: routingIntegrations.length })}
              </span>
            </div>
          </div>
        )}

        {/* Quick-start cards when empty */}
        {!isLoading && routingIntegrations.length === 0 && (
          <Card
            className="max-w-md mx-auto border-dashed cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            onClick={() => navigate("/integrations/new-v2")}
          >
            <CardContent className="flex flex-col items-center text-center py-8 gap-3">
              <div className="h-12 w-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                <Zap className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <p className="font-semibold text-base">{t("integrations.createRoutingTitle")}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
                  {t("integrations.createRoutingBody")}
                </p>
              </div>
              <Button size="sm" className="mt-1">
                {t("integrations.getStarted")}
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Integration list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredIntegrations.length === 0 && routingIntegrations.length > 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center gap-3">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
              <Search className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("integrations.noMatchTitle")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("integrations.noMatchBody")}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={() => { setSearchQuery(""); setFilterStatus("ALL"); }}
            >
              {t("integrations.clearFilters")}
            </Button>
          </div>
        ) : (
          routingIntegrations.length > 0 && (
            <div className="grid gap-2">
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
                  <Card
                    key={integration.id}
                    className={cn(
                      "overflow-hidden transition-colors",
                      !integration.isActive && "bg-muted/25 border-muted-foreground/15"
                    )}
                  >
                    <CardContent className="p-0">
                      <div
                        className={cn(
                          "flex min-h-[3.25rem] items-stretch",
                          !integration.isActive && "opacity-[0.92]"
                        )}
                      >
                        <button
                          type="button"
                          id={`integration-trigger-${integration.id}`}
                          className="hover:bg-muted/30 flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-1 pl-2.5 text-left transition-colors sm:gap-3 sm:px-3"
                          onClick={() => toggleExpand(integration.id)}
                          aria-expanded={isExpanded}
                          aria-controls={`integration-panel-${integration.id}`}
                          aria-label={`${integration.name}, Lead routing${
                            integration.isActive ? ", active" : ", turned off"
                          }. Show details.`}
                        >
                          <div
                            className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                              routingIconBg(integration.isActive),
                            )}
                          >
                            <Zap className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1 py-0.5">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <p
                                className={cn(
                                  "min-w-0 flex-1 truncate text-sm font-semibold leading-tight",
                                  !integration.isActive && "text-foreground/75"
                                )}
                              >
                                {integration.name}
                              </p>
                              <span
                                className={cn(
                                  "inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                  routingBadgeClass(integration.isActive),
                                )}
                              >
                                {t("integrations.routing")}
                              </span>
                            </div>
                            <p
                              className={cn(
                                "mt-0.5 truncate text-[11px] leading-tight sm:text-xs",
                                integration.isActive
                                  ? "text-muted-foreground"
                                  : "text-muted-foreground/80"
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
                          className="bg-muted/20 flex shrink-0 items-center gap-0.5 border-l px-1 py-1.5 sm:gap-1 sm:px-1.5"
                          onClick={(e) => e.stopPropagation()}
                          role="presentation"
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground h-8 w-8"
                            title={t("integrations.editRouting")}
                            onClick={() => navigate(`/integrations/edit-routing/${integration.id}`)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground h-8 w-8"
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
                            className="mx-0.5 shrink-0 scale-90 data-[state=checked]:bg-primary sm:scale-100"
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
                          className="bg-muted/15 border-t px-2.5 pb-2.5 sm:px-3 sm:pb-3"
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

                            {/* Action buttons */}
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
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
                                className="h-8 text-xs"
                                title={t("integrations.editRouting")}
                                onClick={() => navigate(`/integrations/edit-routing/${integration.id}`)}
                              >
                                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                {t("integrations.edit")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
                                onClick={() => setDeleteId(integration.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                {t("integrations.delete")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-1">
                  <p className="text-muted-foreground text-xs">
                    {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredIntegrations.length)} / {filteredIntegrations.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => p - 1)}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                      <Button
                        key={p}
                        variant={p === currentPage ? "default" : "outline"}
                        size="sm"
                        className="h-7 w-7 p-0 text-xs"
                        onClick={() => setCurrentPage(p)}
                      >
                        {p}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0"
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

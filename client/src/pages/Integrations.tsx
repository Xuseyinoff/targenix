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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Globe,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

type IntegrationType = "TELEGRAM" | "AFFILIATE";

interface FormState {
  type: IntegrationType;
  name: string;
  token: string;
  chatId: string;
  url: string;
  headers: string;
  integrationTelegramChatId: string;
}

const DEFAULT_FORM: FormState = {
  type: "TELEGRAM",
  name: "",
  token: "",
  chatId: "",
  url: "",
  headers: "",
  integrationTelegramChatId: "",
};

function typeIcon(type: string) {
  if (type === "TELEGRAM") return <MessageCircle className="h-4 w-4" />;
  if (type === "LEAD_ROUTING") return <Zap className="h-4 w-4" />;
  return <Globe className="h-4 w-4" />;
}

function typeBadgeClass(type: string) {
  if (type === "TELEGRAM") return "bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-950 dark:text-sky-400";
  if (type === "LEAD_ROUTING") return "bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950 dark:text-orange-400";
  return "bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-950 dark:text-violet-400";
}

function typeIconBg(type: string) {
  if (type === "TELEGRAM") return "bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-400";
  if (type === "LEAD_ROUTING") return "bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400";
  return "bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400";
}

export default function Integrations() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { data: integrations, isLoading } = trpc.integrations.list.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"ALL" | "TELEGRAM" | "LEAD_ROUTING" | "AFFILIATE">("ALL");
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

  const createMutation = trpc.integrations.create.useMutation({
    onSuccess: () => {
      toast.success("Integration created successfully");
      utils.integrations.list.invalidate();
      setShowDialog(false);
      setForm(DEFAULT_FORM);
    },
    onError: (err) => toast.error(err.message),
  });

  const toggleMutation = trpc.integrations.toggle.useMutation({
    onSuccess: () => utils.integrations.list.invalidate(),
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.integrations.delete.useMutation({
    onSuccess: () => {
      toast.success("Integration deleted");
      utils.integrations.list.invalidate();
      setDeleteId(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const testMutation = trpc.integrations.testNotification.useMutation({
    onSuccess: () => toast.success("Test notification sent!"),
    onError: (err) => toast.error(`Test failed: ${err.message}`),
  });

  const testLeadMutation = trpc.integrations.testLead.useMutation({
    onSuccess: (data, variables) => {
      const integration = integrations?.find((i) => i.id === variables.id);
      setTestResult({
        integrationId: variables.id,
        integrationName: integration?.name ?? "Integration",
        success: data.success,
        responseData: data.responseData,
        error: data.error,
        durationMs: data.durationMs,
      });
    },
    onError: (err) => toast.error(`Test failed: ${err.message}`),
  });

  const filteredIntegrations = useMemo(() => {
    if (!integrations) return [];
    const q = searchQuery.toLowerCase().trim();
    return integrations.filter((i) => {
      if (filterType !== "ALL" && i.type !== filterType) return false;
      if (filterStatus === "ACTIVE" && !i.isActive) return false;
      if (filterStatus === "INACTIVE" && i.isActive) return false;
      if (!q) return true;
      const config = i.config as Record<string, unknown>;
      return (
        i.name.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        String(i.pageName ?? "").toLowerCase().includes(q) ||
        String(i.formName ?? "").toLowerCase().includes(q) ||
        String((i as { targetWebsiteName?: string }).targetWebsiteName ?? config.targetWebsiteName ?? "").toLowerCase().includes(q) ||
        String(config.chatId ?? "").toLowerCase().includes(q) ||
        String(config.url ?? "").toLowerCase().includes(q)
      );
    });
  }, [integrations, searchQuery, filterType, filterStatus]);

  // Reset to page 1 when filters change
  useEffect(() => { setCurrentPage(1); }, [searchQuery, filterType, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(filteredIntegrations.length / PAGE_SIZE));
  const pagedIntegrations = filteredIntegrations.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const handleCreate = () => {
    const config: Record<string, unknown> =
      form.type === "TELEGRAM"
        ? { token: form.token, chatId: form.chatId }
        : {
            url: form.url,
            headers: form.headers
              ? (() => { try { return JSON.parse(form.headers); } catch { return {}; } })()
              : {},
          };
    createMutation.mutate({
      type: form.type,
      name: form.name,
      config,
      telegramChatId: form.integrationTelegramChatId.trim() || undefined,
    });
  };

  return (
    <DashboardLayout>
      <div className="max-w-4xl space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">Integrations</h1>
            <p className="text-muted-foreground mt-0.5 hidden text-xs sm:block">
              Route leads to Telegram, affiliate endpoints, or target websites
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={() => setShowDialog(true)}
              title="Add Telegram / Affiliate"
            >
              <Plus className="h-4 w-4" />
              <span className="ml-1.5 hidden sm:inline">Telegram / Affiliate</span>
            </Button>
            <Button
              size="sm"
              className="h-8 px-2"
              onClick={() => navigate("/integrations/new-routing")}
              title="New Lead Routing"
            >
              <Zap className="h-4 w-4" />
              <span className="ml-1.5 hidden sm:inline">Lead Routing</span>
            </Button>
          </div>
        </div>

        {/* Search & Filters — shown only when integrations exist */}
        {!isLoading && integrations && integrations.length > 0 && (
          <div className="space-y-2">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-9 pr-9 h-9 text-sm bg-background"
                placeholder="Search by name, page, form, URL..."
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
                {(["ALL", "LEAD_ROUTING", "TELEGRAM", "AFFILIATE"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFilterType(t)}
                    className={cn(
                      "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-all",
                      filterType === t
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t === "ALL"
                      ? "All"
                      : t === "LEAD_ROUTING"
                        ? "Lead Routing"
                        : t === "TELEGRAM"
                          ? "Telegram"
                          : "Affiliate"}
                  </button>
                ))}
              </div>
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
                    {s === "ALL" ? "All Status" : s === "ACTIVE" ? "Active" : "Inactive"}
                  </button>
                ))}
              </div>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                {filteredIntegrations.length === integrations.length
                  ? `${integrations.length} integrations`
                  : `${filteredIntegrations.length} of ${integrations.length}`}
              </span>
            </div>
          </div>
        )}

        {/* Quick-start cards when empty */}
        {!isLoading && !integrations?.length && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card
              className="border-dashed cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
              onClick={() => navigate("/integrations/new-routing")}
            >
              <CardContent className="flex flex-col items-center text-center py-6 gap-2">
                <div className="h-10 w-10 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                  <Zap className="h-5 w-5 text-orange-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Lead Routing</p>
                  <p className="text-xs text-muted-foreground mt-0.5">FB form → target website</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card
              className="border-dashed cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
              onClick={() => { setForm({ ...DEFAULT_FORM, type: "TELEGRAM" }); setShowDialog(true); }}
            >
              <CardContent className="flex flex-col items-center text-center py-6 gap-2">
                <div className="h-10 w-10 rounded-xl bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                  <MessageCircle className="h-5 w-5 text-sky-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Telegram Bot</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Notify a Telegram chat</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card
              className="border-dashed cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
              onClick={() => { setForm({ ...DEFAULT_FORM, type: "AFFILIATE" }); setShowDialog(true); }}
            >
              <CardContent className="flex flex-col items-center text-center py-6 gap-2">
                <div className="h-10 w-10 rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                  <Globe className="h-5 w-5 text-violet-600" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Affiliate Endpoint</p>
                  <p className="text-xs text-muted-foreground mt-0.5">POST to any HTTP endpoint</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </CardContent>
            </Card>
          </div>
        )}

        {/* Integration list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredIntegrations.length === 0 && integrations && integrations.length > 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center gap-3">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
              <Search className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No integrations found</p>
              <p className="text-xs text-muted-foreground mt-0.5">Try adjusting your search or filters</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={() => { setSearchQuery(""); setFilterType("ALL"); setFilterStatus("ALL"); }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          integrations && integrations.length > 0 && (
            <div className="grid gap-2">
              {pagedIntegrations.map((integration) => {
                const config = integration.config as Record<string, unknown>;
                const isTelegram = integration.type === "TELEGRAM";
                const isRouting = integration.type === "LEAD_ROUTING";
                const isExpanded = expandedIds.has(integration.id);
                const varFields = isRouting ? (config.variableFields as Record<string, string> | undefined) : undefined;
                const varEntries = varFields ? Object.entries(varFields).filter(([, v]) => v) : [];

                const summaryLine =
                  isTelegram
                    ? `Chat: ${String(config.chatId ?? "—")}`
                    : isRouting
                      ? [
                          integration.formName,
                          `→ ${String((integration as { targetWebsiteName?: string }).targetWebsiteName ?? config.targetWebsiteName ?? "—")}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : String(config.url ?? "—");

                return (
                  <Card key={integration.id} className="overflow-hidden">
                    <CardContent className="p-0">
                      <div className="flex min-h-[3.25rem] items-stretch">
                        <button
                          type="button"
                          id={`integration-trigger-${integration.id}`}
                          className="hover:bg-muted/30 flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-1 pl-2.5 text-left transition-colors sm:gap-3 sm:px-3"
                          onClick={() => toggleExpand(integration.id)}
                          aria-expanded={isExpanded}
                          aria-controls={`integration-panel-${integration.id}`}
                        >
                          <div
                            className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                              typeIconBg(integration.type)
                            )}
                          >
                            {typeIcon(integration.type)}
                          </div>
                          <div className="min-w-0 flex-1 py-0.5">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <p className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
                                {integration.name}
                              </p>
                              <span
                                className={cn(
                                  "inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                  typeBadgeClass(integration.type)
                                )}
                              >
                                {integration.type === "LEAD_ROUTING" ? "Lead Routing" : integration.type}
                              </span>
                              {!integration.isActive && (
                                <span className="text-muted-foreground inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                                  Inactive
                                </span>
                              )}
                            </div>
                            <p className="text-muted-foreground mt-0.5 truncate text-[11px] leading-tight sm:text-xs">
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
                          {isRouting && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground hover:text-foreground h-8 w-8"
                                title="Edit routing"
                                onClick={() => navigate(`/integrations/edit-routing/${integration.id}`)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground hover:text-foreground h-8 w-8"
                                title="Test lead"
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
                            </>
                          )}
                          {isTelegram && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-foreground h-8 w-8"
                              title="Send test notification"
                              disabled={testMutation.isPending}
                              onClick={() => testMutation.mutate({ id: integration.id })}
                            >
                              {testMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Send className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          )}
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
                            {/* Detail rows */}
                            {isTelegram && (
                              <div className="text-xs text-muted-foreground">
                                Chat ID: <code className="bg-muted px-1.5 py-0.5 rounded">{String(config.chatId ?? "—")}</code>
                              </div>
                            )}
                            {isRouting && (
                              <>
                                <div className="text-xs text-muted-foreground">
                                  Page: <span className="font-medium text-foreground">{String(integration.pageName ?? "—")}</span>
                                  {" · "}
                                  Form: <span className="font-medium text-foreground">{String(integration.formName ?? "—")}</span>
                                </div>
                                {((integration as {targetWebsiteName?: string}).targetWebsiteName ?? config.targetWebsiteName) && (
                                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                                    <span>→</span>
                                    <span className="font-medium text-foreground">{String((integration as {targetWebsiteName?: string}).targetWebsiteName ?? config.targetWebsiteName)}</span>
                                  </div>
                                )}
                                {varEntries.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {varEntries.map(([key, val]) => (
                                      <span
                                        key={key}
                                        className="inline-flex items-center gap-1 text-[11px] bg-muted border rounded px-1.5 py-0.5 font-mono"
                                      >
                                        <span className="text-muted-foreground">{key}:</span>
                                        <span className="font-semibold text-foreground">{val}</span>
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                            {!isTelegram && !isRouting && (
                              <div className="text-xs text-muted-foreground">
                                URL: <code className="bg-muted px-1.5 py-0.5 rounded break-all">{String(config.url ?? "—")}</code>
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground/50">
                              Added {new Date(integration.createdAt).toLocaleDateString()}
                            </p>

                            {/* Action buttons */}
                            <div className="flex items-center gap-2 pt-1 flex-wrap">
                              {isTelegram && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-xs"
                                  title="Send test notification"
                                  disabled={testMutation.isPending}
                                  onClick={() => testMutation.mutate({ id: integration.id })}
                                >
                                  {testMutation.isPending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                                  ) : (
                                    <Send className="h-3.5 w-3.5 mr-1.5" />
                                  )}
                                  Test
                                </Button>
                              )}
                              {isRouting && (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 text-xs"
                                    title="Send test lead"
                                    disabled={testLeadMutation.isPending && testLeadMutation.variables?.id === integration.id}
                                    onClick={() => testLeadMutation.mutate({ id: integration.id })}
                                  >
                                    {testLeadMutation.isPending && testLeadMutation.variables?.id === integration.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                                    ) : (
                                      <FlaskConical className="h-3.5 w-3.5 mr-1.5" />
                                    )}
                                    Test Lead
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 text-xs"
                                    title="Edit routing"
                                    onClick={() => navigate(`/integrations/edit-routing/${integration.id}`)}
                                  >
                                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                                    Edit
                                  </Button>
                                </>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
                                onClick={() => setDeleteId(integration.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                Delete
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

      {/* Create Telegram/Affiliate Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Integration</DialogTitle>
            <DialogDescription>Configure a Telegram bot or affiliate endpoint</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as IntegrationType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TELEGRAM">Telegram Bot</SelectItem>
                  <SelectItem value="AFFILIATE">Affiliate Endpoint</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                placeholder="e.g. Main Telegram Channel"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            {form.type === "TELEGRAM" ? (
              <>
                <div className="space-y-1.5">
                  <Label>Bot Token</Label>
                  <Input
                    type="password"
                    placeholder="123456:ABC-DEF..."
                    value={form.token}
                    onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Chat ID</Label>
                  <Input
                    placeholder="-100123456789"
                    value={form.chatId}
                    onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>Endpoint URL</Label>
                  <Input
                    placeholder="https://example.com/api/leads"
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Headers (JSON, optional)</Label>
                  <Input
                    placeholder='{"Authorization": "Bearer token"}'
                    value={form.headers}
                    onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Telegram Chat ID (optional)</Label>
                  <Input
                    placeholder="-1001234567890"
                    value={form.integrationTelegramChatId}
                    onChange={(e) => setForm((f) => ({ ...f, integrationTelegramChatId: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Send lead notifications to a specific channel or group instead of your personal Telegram.
                    Add @TargenixBot as admin, then paste the Chat ID (e.g. -1001234567890).
                  </p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending || !form.name.trim()}
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              Test Lead — {testResult?.integrationName}
            </DialogTitle>
            <DialogDescription>
              Sintetik lead yuborildi: Test Foydalanuvchi · +998901234567
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
                {testResult?.success ? "✅ MUVAFFAQIYATLI" : "❌ XATO"}
              </p>
              {testResult?.durationMs !== undefined && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Vaqt: {(testResult.durationMs / 1000).toFixed(2)}s
                </p>
              )}
            </div>
            {testResult?.error && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-800 p-3">
                <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1">Xato:</p>
                <p className="text-xs text-red-600 dark:text-red-300 font-mono break-all">{testResult.error}</p>
              </div>
            )}
            {testResult?.responseData !== null && testResult?.responseData !== undefined && (
              <div className="rounded-lg border bg-muted/50 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1">Server javobi:</p>
                <pre className="text-xs font-mono break-all whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {typeof testResult.responseData === "string"
                    ? testResult.responseData
                    : JSON.stringify(testResult.responseData, null, 2)}
                </pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestResult(null)}>Yopish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Integration</DialogTitle>
            <DialogDescription>This integration will stop forwarding leads.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate({ id: deleteId })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

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
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

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
        String((i as { targetWebsiteName?: string }).targetWebsiteName ?? config.targetWebsiteName ?? "").toLowerCase().includes(q) ||
        String(config.chatId ?? "").toLowerCase().includes(q) ||
        String(config.url ?? "").toLowerCase().includes(q)
      );
    });
  }, [integrations, searchQuery, filterType, filterStatus]);

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
      <div className="space-y-4 max-w-4xl">
        {/* Header — compact */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">Integrations</h1>
            <p className="text-muted-foreground text-xs mt-0.5 hidden sm:block">
              Route leads to Telegram, affiliate endpoints, or target websites
            </p>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={() => setShowDialog(true)}
              title="Add Telegram / Affiliate"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Telegram / Affiliate</span>
            </Button>
            <Button
              size="sm"
              className="h-8 px-2"
              onClick={() => navigate("/integrations/new-routing")}
              title="New Lead Routing"
            >
              <Zap className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Lead Routing</span>
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
                placeholder="Search by name, type, page, URL..."
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

            {/* Filter chips row */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Type chips */}
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
                {(["ALL", "LEAD_ROUTING", "TELEGRAM", "AFFILIATE"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setFilterType(t)}
                    className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${
                      filterType === t
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t === "ALL" ? "All" : t === "LEAD_ROUTING" ? "Lead Routing" : t === "TELEGRAM" ? "Telegram" : "Affiliate"}
                  </button>
                ))}
              </div>

              {/* Status chips */}
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
                {(["ALL", "ACTIVE", "INACTIVE"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterStatus(s)}
                    className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${
                      filterStatus === s
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {s === "ALL" ? "All Status" : s === "ACTIVE" ? "Active" : "Inactive"}
                  </button>
                ))}
              </div>

              {/* Results count */}
              <span className="text-xs text-muted-foreground ml-auto">
                {filteredIntegrations.length} of {integrations.length} integrations
              </span>
            </div>
          </div>
        )}

        {/* Quick-start cards when empty */}
        {!isLoading && !integrations?.length && (
          <div className="grid sm:grid-cols-3 gap-3">
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
              {filteredIntegrations.map((integration) => {
                const config = integration.config as Record<string, unknown>;
                const isTelegram = integration.type === "TELEGRAM";
                const isRouting = integration.type === "LEAD_ROUTING";
                const isExpanded = expandedIds.has(integration.id);
                const varFields = isRouting ? (config.variableFields as Record<string, string> | undefined) : undefined;
                const varEntries = varFields ? Object.entries(varFields).filter(([, v]) => v) : [];

                return (
                  <Card key={integration.id} className="overflow-hidden">
                    {/* Collapsed header — always visible */}
                    <CardContent className="p-0">
                      <button
                        className="w-full text-left"
                        onClick={() => toggleExpand(integration.id)}
                        aria-expanded={isExpanded}
                      >
                        <div className="flex items-center gap-3 px-3 py-3 hover:bg-muted/30 transition-colors">
                          {/* Icon */}
                          <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${typeIconBg(integration.type)}`}>
                            {typeIcon(integration.type)}
                          </div>

                          {/* Name + badge */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold text-sm truncate">{integration.name}</p>
                              <span className={`text-[11px] px-1.5 py-0.5 rounded-full border font-medium shrink-0 ${typeBadgeClass(integration.type)}`}>
                                {integration.type === "LEAD_ROUTING" ? "Lead Routing" : integration.type}
                              </span>
                              {!integration.isActive && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded-full border font-medium text-muted-foreground shrink-0">
                                  Inactive
                                </span>
                              )}
                            </div>
                            {/* Compact summary line */}
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {isTelegram && `Chat: ${String(config.chatId ?? "—")}`}
                              {isRouting && `${String(integration.pageName ?? "—")} → ${String((integration as {targetWebsiteName?: string}).targetWebsiteName ?? config.targetWebsiteName ?? "—")}`}
                              {!isTelegram && !isRouting && String(config.url ?? "—")}
                            </p>
                          </div>

                          {/* Switch + chevron */}
                          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={integration.isActive}
                              onCheckedChange={(checked) =>
                                toggleMutation.mutate({ id: integration.id, isActive: checked })
                              }
                            />
                          </div>
                          <ChevronDown
                            className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`}
                          />
                        </div>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-3 pb-3 border-t bg-muted/20">
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

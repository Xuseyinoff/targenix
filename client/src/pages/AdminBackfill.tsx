import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Shield, Users, Zap, ChevronRight, ChevronLeft, Send, CheckCircle2, XCircle, Loader2, RefreshCw, ChevronsUpDown, Search } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { toast } from "sonner";
import { leadIsRetryable } from "@/lib/leadPipelineBadgeModel";

type Step = 1 | 2 | 3 | 4;
type Mode = "count" | "hours" | "manual";

interface SendResult {
  leadId: number;
  fullName: string | null;
  phone: string | null;
  success: boolean;
  error?: string;
}

export default function AdminBackfill() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  // Redirect non-admins
  useEffect(() => {
    if (user && user.role !== "admin") setLocation("/overview");
  }, [user, setLocation]);

  // ── Wizard state ────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>(1);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("count");
  const [count, setCount] = useState(15);
  const [hours, setHours] = useState(24);
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<number>>(new Set());
  const [sendTelegram, setSendTelegram] = useState(true);
  const [sendResults, setSendResults] = useState<SendResult[] | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [integrationDialogOpen, setIntegrationDialogOpen] = useState(false);

  // ── Data queries ────────────────────────────────────────────────────────────
  const { data: usersData, isLoading: loadingUsers } = trpc.adminBackfill.listUsers.useQuery(
    undefined,
    { enabled: user?.role === "admin" }
  );

  const { data: integrationsData, isLoading: loadingIntegrations } = trpc.adminBackfill.listIntegrations.useQuery(
    { userId: selectedUserId! },
    { enabled: !!selectedUserId && user?.role === "admin" }
  );

  const previewInput = selectedIntegrationId
    ? {
        integrationId: selectedIntegrationId,
        mode,
        count: mode === "count" ? count : undefined,
        hours: mode === "hours" ? hours : undefined,
        leadIds: mode === "manual" ? Array.from(selectedLeadIds) : undefined,
      }
    : null;

  const { data: previewData, isLoading: loadingPreview, refetch: refetchPreview } =
    trpc.adminBackfill.previewLeads.useQuery(previewInput!, {
      enabled: !!previewInput && step >= 3,
    });

  const sendMutation = trpc.adminBackfill.sendLeads.useMutation();

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!selectedIntegrationId || !previewData?.leads.length) return;
    const ids = mode === "manual"
      ? Array.from(selectedLeadIds)
      : previewData.leads.map(l => l.id);
    if (ids.length === 0) { toast.error("No leads selected"); return; }

    setIsSending(true);
    try {
      const res = await sendMutation.mutateAsync({
        integrationId: selectedIntegrationId,
        leadIds: ids,
        sendTelegram,
      });
      setSendResults(res.results);
      setStep(4);
      toast.success(`${res.sent}/${res.total} leads sent successfully`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setIsSending(false);
    }
  };

  const reset = () => {
    setStep(1);
    setSelectedUserId(null);
    setSelectedIntegrationId(null);
    setMode("count");
    setCount(15);
    setHours(24);
    setSelectedLeadIds(new Set());
    setSendResults(null);
  };

  // ── Guard ───────────────────────────────────────────────────────────────────
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

  const selectedUser = usersData?.find(u => u.id === selectedUserId);
  const selectedIntegration = integrationsData?.find(i => i.id === selectedIntegrationId);

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Lead Backfill</h1>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                <Shield className="h-3 w-3" />
                Admin only
              </span>
            </div>
            <p className="text-muted-foreground text-sm mt-1">
              Send pre-integration leads to affiliate websites on behalf of any user
            </p>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-sm">
          {[
            { n: 1, label: "Select User" },
            { n: 2, label: "Select Integration" },
            { n: 3, label: "Preview & Send" },
            { n: 4, label: "Results" },
          ].map(({ n, label }, idx) => (
            <div key={n} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                step === n
                  ? "bg-primary text-primary-foreground"
                  : step > n
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
              }`}>
                {step > n ? <CheckCircle2 className="h-3 w-3" /> : <span>{n}</span>}
                {label}
              </div>
              {idx < 3 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          ))}
        </div>

        {/* ── Step 1: Select User ─────────────────────────────────────────── */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" /> Select User
              </CardTitle>
              <CardDescription>Choose which user's integrations to backfill</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Search trigger */}
              <button
                type="button"
                onClick={() => setUserDialogOpen(true)}
                disabled={loadingUsers}
                className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border hover:border-primary/60 hover:bg-muted/40 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingUsers ? (
                  <span className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading users...
                  </span>
                ) : selectedUser ? (
                  <span className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Users className="h-4 w-4 text-primary" />
                    </div>
                    <span>
                      <p className="font-medium text-sm">{selectedUser.name || selectedUser.email}</p>
                      <p className="text-xs text-muted-foreground">{selectedUser.email}</p>
                    </span>
                  </span>
                ) : (
                  <span className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Search className="h-4 w-4" />
                    Search and select a user...
                  </span>
                )}
                <ChevronsUpDown className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
              </button>

              {/* User search dialog */}
              <CommandDialog
                open={userDialogOpen}
                onOpenChange={setUserDialogOpen}
                title="Select User"
                description="Search users by name or email"
              >
                <CommandInput placeholder="Search by name or email..." />
                <CommandList className="max-h-80">
                  <CommandEmpty>No users found.</CommandEmpty>
                  <CommandGroup heading={`${usersData?.length ?? 0} users`}>
                    {usersData?.map(u => (
                      <CommandItem
                        key={u.id}
                        value={`${u.name ?? ""} ${u.email} ${u.role}`}
                        onSelect={() => {
                          setSelectedUserId(u.id);
                          setSelectedIntegrationId(null);
                          setUserDialogOpen(false);
                        }}
                        className="flex items-center justify-between py-2.5 cursor-pointer"
                      >
                        <span className="flex items-center gap-3">
                          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-semibold uppercase">
                            {(u.name ?? u.email ?? "?").charAt(0)}
                          </div>
                          <span>
                            <p className="font-medium text-sm leading-tight">{u.name ?? u.email ?? "Unknown user"}</p>
                            <p className="text-xs text-muted-foreground leading-tight">{u.email ?? "No email"}</p>
                          </span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0 ml-2">
                          {u.role === "admin" && (
                            <Badge variant="secondary" className="text-xs">Admin</Badge>
                          )}
                          {selectedUserId === u.id && (
                            <CheckCircle2 className="h-4 w-4 text-primary" />
                          )}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </CommandDialog>

              <div className="flex justify-end pt-1">
                <Button disabled={!selectedUserId} onClick={() => setStep(2)}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Select Integration ──────────────────────────────────── */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="h-4 w-4" /> Select Integration
              </CardTitle>
              <CardDescription>
                LEAD_ROUTING integrations for <strong>{selectedUser?.name || selectedUser?.email}</strong>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Search trigger */}
              <button
                type="button"
                onClick={() => setIntegrationDialogOpen(true)}
                disabled={loadingIntegrations}
                className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border hover:border-primary/60 hover:bg-muted/40 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingIntegrations ? (
                  <span className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading integrations...
                  </span>
                ) : selectedIntegration ? (
                  <span className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Zap className="h-4 w-4 text-primary" />
                    </div>
                    <span className="min-w-0">
                      <p className="font-medium text-sm truncate">{selectedIntegration.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[selectedIntegration.accountName, selectedIntegration.pageName, selectedIntegration.targetWebsiteName]
                          .filter(Boolean).join(" · ")}
                      </p>
                    </span>
                  </span>
                ) : integrationsData?.length === 0 ? (
                  <span className="text-muted-foreground text-sm">No LEAD_ROUTING integrations found for this user</span>
                ) : (
                  <span className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Search className="h-4 w-4" />
                    Search and select an integration...
                  </span>
                )}
                <ChevronsUpDown className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
              </button>

              {/* Integration search dialog */}
              <CommandDialog
                open={integrationDialogOpen}
                onOpenChange={setIntegrationDialogOpen}
                title="Select Integration"
                description="Search integrations by name, account, page, form, or target website"
              >
                <CommandInput placeholder="Search integrations..." />
                <CommandList className="max-h-96">
                  <CommandEmpty>No integrations found.</CommandEmpty>
                  <CommandGroup heading={`${integrationsData?.length ?? 0} integrations`}>
                    {integrationsData?.map(intg => (
                      <CommandItem
                        key={intg.id}
                        value={`${intg.name} ${intg.accountName ?? ""} ${intg.pageName ?? ""} ${intg.formName ?? ""} ${intg.targetWebsiteName ?? ""}`}
                        onSelect={() => {
                          setSelectedIntegrationId(intg.id);
                          setIntegrationDialogOpen(false);
                        }}
                        className="flex items-start justify-between py-2.5 cursor-pointer"
                      >
                        <span className="flex items-start gap-3 min-w-0">
                          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <span className="min-w-0">
                            <p className="font-medium text-sm leading-tight truncate">{intg.name}</p>
                            <div className="flex flex-wrap gap-x-2 gap-y-0 text-xs text-muted-foreground leading-tight mt-0.5">
                              {intg.accountName && <span>Account: {intg.accountName}</span>}
                              {intg.pageName && <span>Page: {intg.pageName}</span>}
                              {intg.formName && <span>Form: {intg.formName}</span>}
                              {intg.targetWebsiteName && <span>→ {intg.targetWebsiteName}</span>}
                            </div>
                          </span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0 ml-2 mt-0.5">
                          <Badge variant={intg.isActive ? "default" : "secondary"} className="text-xs">
                            {intg.isActive ? "Active" : "Inactive"}
                          </Badge>
                          {selectedIntegrationId === intg.id && (
                            <CheckCircle2 className="h-4 w-4 text-primary" />
                          )}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </CommandDialog>

              <div className="flex justify-between pt-1">
                <Button variant="outline" onClick={() => setStep(1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Back
                </Button>
                <Button disabled={!selectedIntegrationId} onClick={() => setStep(3)}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Preview & Send ──────────────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-4">
            {/* Mode selector */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Lead Selection Mode</CardTitle>
                <CardDescription>
                  Leads for <strong>{selectedIntegration?.name}</strong> before{" "}
                  {selectedIntegration && new Date(selectedIntegration.createdAt).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  {(["count", "hours", "manual"] as Mode[]).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                        mode === m
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      {m === "count" ? "Last N leads" : m === "hours" ? "By hours" : "Manual select"}
                    </button>
                  ))}
                </div>

                {mode === "count" && (
                  <div className="flex items-center gap-3">
                    <Label className="text-sm w-32 shrink-0">Number of leads</Label>
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={count}
                      onChange={e => setCount(Number(e.target.value))}
                      className="w-28"
                    />
                  </div>
                )}

                {mode === "hours" && (
                  <div className="flex items-center gap-3">
                    <Label className="text-sm w-32 shrink-0">Hours before creation</Label>
                    <Input
                      type="number"
                      min={1}
                      max={720}
                      value={hours}
                      onChange={e => setHours(Number(e.target.value))}
                      className="w-28"
                    />
                    <span className="text-sm text-muted-foreground">hours</span>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-1">
                  <Button variant="outline" size="sm" onClick={() => refetchPreview()}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Load Preview
                  </Button>
                  {previewData && (
                    <span className="text-sm text-muted-foreground">
                      {previewData.total} lead{previewData.total !== 1 ? "s" : ""} found
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Lead list preview */}
            {loadingPreview ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading leads...
              </div>
            ) : previewData?.leads.length ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">
                    {mode === "manual" ? "Select leads to send" : `Preview — ${previewData.total} leads`}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                    {previewData.leads.map(lead => (
                      <div
                        key={lead.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors"
                      >
                        {mode === "manual" && (
                          <Checkbox
                            id={`lead-${lead.id}`}
                            checked={selectedLeadIds.has(lead.id)}
                            onCheckedChange={checked => {
                              setSelectedLeadIds(prev => {
                                const next = new Set(prev);
                                checked ? next.add(lead.id) : next.delete(lead.id);
                                return next;
                              });
                            }}
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{lead.fullName || "—"}</p>
                          <p className="text-xs text-muted-foreground">{lead.phone || "—"}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs text-muted-foreground">
                            {new Date(lead.createdAt).toLocaleString()}
                          </p>
                          <Badge
                            variant={
                              leadIsRetryable({
                                dataStatus: (lead as { dataStatus?: string }).dataStatus ?? "",
                                deliveryStatus: (lead as { deliveryStatus?: string }).deliveryStatus ?? "",
                              })
                                ? "destructive"
                                : "secondary"
                            }
                            className="text-xs max-w-[140px] truncate"
                            title={`${(lead as { dataStatus?: string }).dataStatus} / ${(lead as { deliveryStatus?: string }).deliveryStatus}`}
                          >
                            {(lead as { dataStatus?: string }).dataStatus ?? "?"}
                            {" / "}
                            {(lead as { deliveryStatus?: string }).deliveryStatus ?? "?"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  {mode === "manual" && (
                    <div className="flex items-center justify-between pt-3 border-t mt-2">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => {
                          const allIds = new Set(previewData.leads.map(l => l.id));
                          setSelectedLeadIds(prev => prev.size === allIds.size ? new Set() : allIds);
                        }}
                      >
                        {selectedLeadIds.size === previewData.leads.length ? "Deselect all" : "Select all"}
                      </button>
                      <span className="text-xs text-muted-foreground">{selectedLeadIds.size} selected</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : previewData?.leads.length === 0 ? (
              <p className="text-muted-foreground text-sm">No leads found for the selected criteria.</p>
            ) : null}

            {/* Send options */}
            <Card>
              <CardContent className="pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">Send Telegram notification</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Sends to user's Telegram with <code className="bg-muted px-1 rounded">[ADMIN]</code> badge
                    </p>
                  </div>
                  <Switch checked={sendTelegram} onCheckedChange={setSendTelegram} />
                </div>

                <div className="flex justify-between pt-1">
                  <Button variant="outline" onClick={() => setStep(2)}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                  <Button
                    disabled={
                      isSending ||
                      !previewData?.leads.length ||
                      (mode === "manual" && selectedLeadIds.size === 0)
                    }
                    onClick={handleSend}
                  >
                    {isSending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending...</>
                    ) : (
                      <><Send className="h-4 w-4 mr-2" />
                        Send {mode === "manual" ? selectedLeadIds.size : previewData?.total ?? 0} leads</>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Step 4: Results ─────────────────────────────────────────────── */}
        {step === 4 && sendResults && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500" /> Backfill Complete
                </CardTitle>
                <CardDescription>
                  {sendResults.filter(r => r.success).length} sent ·{" "}
                  {sendResults.filter(r => !r.success).length} failed ·{" "}
                  {sendResults.length} total
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
                  {sendResults.map(r => (
                    <div key={r.leadId} className="flex items-center gap-3 px-3 py-2 rounded-lg">
                      {r.success
                        ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{r.fullName || "—"}</p>
                        <p className="text-xs text-muted-foreground">{r.phone || "—"}</p>
                      </div>
                      {!r.success && r.error && (
                        <p className="text-xs text-destructive truncate max-w-48">{r.error}</p>
                      )}
                      <Badge variant={r.success ? "default" : "destructive"} className="text-xs shrink-0">
                        {r.success ? "SENT" : "FAILED"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2">
              <Button variant="outline" onClick={reset}>
                <RefreshCw className="h-4 w-4 mr-2" /> New Backfill
              </Button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

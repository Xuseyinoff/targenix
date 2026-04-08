/**
 * LeadRoutingWizard — multi-step wizard for creating a LEAD_ROUTING integration.
 *
 * Steps:
 *  1. Select Facebook Account
 *  2. Select Page (loaded from account)
 *  3. Select Lead Form (loaded from page)
 *  4. Map Fields (name field, phone field)
 *  5. Select Target Website + enter flow + offer_id
 *  6. Review & Save (subscribes page, creates integration)
 */

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Facebook,
  FileText,
  Globe,
  Loader2,
  Plus,
  Tag,
  User,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import type { RouteComponentProps } from "wouter";


// ─── ScrollableList component ────────────────────────────────────────────────
// Each item is ~64px (p-3 + border + gap-2). 5 items ≈ 5 × 64 = 320px visible.
const ITEM_HEIGHT = 64; // px per item (approx)
const VISIBLE_ITEMS = 5;

function ScrollableList({ children, count }: { children: React.ReactNode; count: number }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [showTopShadow, setShowTopShadow] = useState(false);
  const [showBottomShadow, setShowBottomShadow] = useState(false);

  const updateShadows = () => {
    const el = listRef.current;
    if (!el) return;
    setShowTopShadow(el.scrollTop > 4);
    setShowBottomShadow(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  };

  useEffect(() => {
    updateShadows();
  });

  const needsScroll = count > VISIBLE_ITEMS;
  const maxHeight = needsScroll ? ITEM_HEIGHT * VISIBLE_ITEMS + (VISIBLE_ITEMS - 1) * 8 : undefined;

  return (
    <div className="relative">
      {/* Top shadow */}
      {showTopShadow && (
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-8 z-10 bg-gradient-to-b from-background to-transparent rounded-t-lg" />
      )}
      <div
        ref={listRef}
        onScroll={updateShadows}
        className="grid gap-2 overflow-y-auto pr-1"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>
      {/* Bottom shadow */}
      {showBottomShadow && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 z-10 bg-gradient-to-t from-background to-transparent rounded-b-lg" />
      )}
      {/* Scroll hint */}
      {needsScroll && (
        <div className="flex justify-center mt-1 gap-1 text-muted-foreground/50 text-xs select-none">
          <span>↑↓</span>
          <span>{count} items — scroll to see all</span>
        </div>
      )}
    </div>
  );
}


// ─── Auto-match helpers ───────────────────────────────────────────────────────

const NAME_PATTERNS = [
  "full_name", "fullname", "name", "first_name", "firstname",
  "имя", "фио", "ismi", "ism", "полное_имя", "полное имя",
];

const PHONE_PATTERNS = [
  "phone", "phone_number", "phonenumber", "telefon", "телефон",
  "mobile", "номер_телефона", "номер телефона", "raqam",
];

function autoMatchField(fields: { key: string }[], patterns: string[]): string {
  for (const f of fields) {
    const key = f.key.toLowerCase();
    if (patterns.some((p) => key.includes(p))) return f.key;
  }
  return "";
}

// ─── State ────────────────────────────────────────────────────────────────────

interface WizardState {
  // Step 1
  accountId: number | null;
  accountName: string;
  // Step 2
  pageId: string;
  pageName: string;
  // Step 3
  formId: string;
  formName: string;
  // Step 4
  nameField: string;
  phoneField: string;
  // Step 5
  targetWebsiteId: number | null;
  targetWebsiteName: string;
  targetTemplateType: string;
  /** Variable fields per routing (offer_id, stream, stream_id, etc.) */
  variableFields: Record<string, string>;
  // Meta
  integrationName: string;
}

const INITIAL: WizardState = {
  accountId: null,
  accountName: "",
  pageId: "",
  pageName: "",
  formId: "",
  formName: "",
  nameField: "",
  phoneField: "",
  targetWebsiteId: null,
  targetWebsiteName: "",
  targetTemplateType: "",
  variableFields: {},
  integrationName: "",
};

// ─── Template variable field definitions (client-side) ────────────────────────
const TEMPLATE_VARIABLE_FIELDS: Record<string, Array<{ key: string; label: string; placeholder: string; required: boolean }>> = {
  sotuvchi: [
    { key: "offer_id", label: "Offer ID", placeholder: "e.g. 123", required: true },
    { key: "stream", label: "Stream", placeholder: "e.g. main", required: true },
  ],
  "100k": [
    { key: "stream_id", label: "Stream ID", placeholder: "e.g. 456", required: true },
  ],
  custom: [],
};

const STEPS = [
  { id: 1, label: "Account", icon: User },
  { id: 2, label: "Page", icon: Facebook },
  { id: 3, label: "Form", icon: FileText },
  { id: 4, label: "Fields", icon: Tag },
  { id: 5, label: "Target", icon: Globe },
  { id: 6, label: "Review", icon: CheckCircle2 },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function LeadRoutingWizard({ params }: RouteComponentProps<{ id?: string }>) {
  const editIntegrationId = params?.id ? parseInt(params.id, 10) : null;
  const isEditMode = !!editIntegrationId && !isNaN(editIntegrationId);
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [editLoaded, setEditLoaded] = useState(false);
  const utils = trpc.useUtils();

  const set = (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch }));

  // ── Data queries ─────────────────────────────────────────────────────────
  const { data: accounts, isLoading: loadingAccounts } = trpc.facebookAccounts.list.useQuery();
  const { data: pages, isLoading: loadingPages } = trpc.facebookAccounts.listPages.useQuery(
    { accountId: state.accountId! },
    { enabled: !!state.accountId && step >= 2 }
  );
  const { data: forms, isLoading: loadingForms } = trpc.facebookAccounts.listForms.useQuery(
    { accountId: state.accountId!, pageId: state.pageId },
    { enabled: !!state.accountId && !!state.pageId && step >= 3 }
  );
  const { data: formFields, isLoading: loadingFields } = trpc.facebookAccounts.listFormFields.useQuery(
    { accountId: state.accountId!, pageId: state.pageId, formId: state.formId },
    { enabled: !!state.accountId && !!state.pageId && !!state.formId && step >= 4 }
  );

  // Auto-select name/phone fields when formFields load
  useEffect(() => {
    if (!formFields?.length) return;
    const autoName = autoMatchField(formFields, NAME_PATTERNS);
    const autoPhone = autoMatchField(formFields, PHONE_PATTERNS);
    set({
      nameField: autoName || state.nameField,
      phoneField: autoPhone || state.phoneField,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formFields]);
  const { data: targetWebsites, isLoading: loadingTargets } = trpc.targetWebsites.list.useQuery(
    undefined,
    { enabled: step >= 5 }
  );

  // Auto-detect custom variables from the selected custom template's body
  const { data: customVarNames = [] } = trpc.targetWebsites.getCustomVariables.useQuery(
    { id: state.targetWebsiteId! },
    { enabled: step >= 5 && !!state.targetWebsiteId && state.targetTemplateType === "custom" }
  );

  // ── Load existing integration for edit mode ──────────────────────────────
  const { data: allIntegrations } = trpc.integrations.list.useQuery(undefined, {
    enabled: isEditMode && !editLoaded,
  });
  useEffect(() => {
    if (!isEditMode || editLoaded || !allIntegrations) return;
    const found = allIntegrations.find((i) => i.id === editIntegrationId);
    if (!found) return;
    const cfg = (found.config ?? {}) as Record<string, unknown>;
    setState({
      accountId: (cfg.facebookAccountId as number) ?? null,
      accountName: "",
      // Use dedicated columns first (migrated), fall back to config for legacy safety
      pageId: found.pageId ?? (cfg.pageId as string) ?? "",
      pageName: found.pageName ?? (cfg.pageName as string) ?? "",
      formId: found.formId ?? (cfg.formId as string) ?? "",
      formName: found.formName ?? (cfg.formName as string) ?? "",
      nameField: (cfg.nameField as string) ?? "",
      phoneField: (cfg.phoneField as string) ?? "",
      targetWebsiteId: found.targetWebsiteId ?? (cfg.targetWebsiteId as number) ?? null,
      targetWebsiteName: (cfg.targetWebsiteName as string) ?? "",
      targetTemplateType: (cfg.targetTemplateType as string) ?? "",
      variableFields: (cfg.variableFields as Record<string, string>) ?? {},
      integrationName: found.name ?? "",
    });
    setEditLoaded(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allIntegrations, isEditMode, editIntegrationId, editLoaded]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const subscribeMutation = trpc.facebookAccounts.subscribePage.useMutation();
  const updateIntegration = trpc.integrations.update.useMutation({
    onSuccess: () => {
      toast.success("Integration updated successfully!");
      utils.integrations.list.invalidate();
      navigate("/integrations");
    },
    onError: (err) => toast.error(err.message),
  });
  const createIntegration = trpc.integrations.create.useMutation({
    onSuccess: () => {
      toast.success("Integration created successfully!");
      utils.integrations.list.invalidate();
      navigate("/integrations");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = async () => {
    if (!state.accountId || !state.pageId || !state.formId || !state.targetWebsiteId) return;
    const integrationConfig = {
      facebookAccountId: state.accountId,
      pageId: state.pageId,
      pageName: state.pageName,
      formId: state.formId,
      formName: state.formName,
      nameField: state.nameField,
      phoneField: state.phoneField,
      targetWebsiteId: state.targetWebsiteId,
      targetWebsiteName: state.targetWebsiteName,
      targetTemplateType: state.targetTemplateType,
      variableFields: state.variableFields,
    };
    const integrationName = state.integrationName || `${state.pageName} → ${state.targetWebsiteName}`;
    try {
      // Subscribe page to receive webhooks
      await subscribeMutation.mutateAsync({
        accountId: state.accountId,
        pageId: state.pageId,
      });
      if (isEditMode && editIntegrationId) {
        await updateIntegration.mutateAsync({
          id: editIntegrationId,
          name: integrationName,
          config: integrationConfig,
        });
      } else {
        await createIntegration.mutateAsync({
          type: "LEAD_ROUTING",
          name: integrationName,
          config: integrationConfig,
        });
      }
    } catch (err: any) {
      toast.error(err.message ?? (isEditMode ? "Failed to update integration" : "Failed to create integration"));
    }
  };

  const canNext = () => {
    if (step === 1) return !!state.accountId;
    if (step === 2) return !!state.pageId;
    if (step === 3) return !!state.formId;
    if (step === 4) return !!state.nameField && !!state.phoneField;
    if (step === 5) {
      if (!state.targetWebsiteId) return false;
      if (state.targetTemplateType === "custom") {
        // For custom templates, all auto-detected variables must be filled
        return customVarNames.every((k) => !!state.variableFields[k]?.trim());
      }
      const vfDefs = TEMPLATE_VARIABLE_FIELDS[state.targetTemplateType] ?? [];
      return vfDefs.every((vf) => !vf.required || !!state.variableFields[vf.key]?.trim());
    }
    return true;
  };

  const isSaving = subscribeMutation.isPending || createIntegration.isPending || updateIntegration.isPending;

  return (
    <DashboardLayout>
      <div className="max-w-2xl space-y-6">
        {/* Header */}
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={() => navigate("/integrations")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Integrations
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">{isEditMode ? "Edit Lead Routing" : "New Lead Routing"}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isEditMode ? "Update your routing configuration" : "Connect a Facebook lead form to a target website in 6 steps"}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const done = step > s.id;
            const active = step === s.id;
            return (
              <div key={s.id} className="flex items-center">
                <div
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    done
                      ? "bg-primary/10 text-primary"
                      : active
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {done ? <CheckCircle2 className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                  <span className="hidden sm:inline">{s.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <ChevronRight className="h-3 w-3 text-muted-foreground mx-0.5" />
                )}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {step === 1 && "Step 1: Select Facebook Account"}
              {step === 2 && "Step 2: Select Facebook Page"}
              {step === 3 && "Step 3: Select Lead Form"}
              {step === 4 && "Step 4: Map Form Fields"}
              {step === 5 && "Step 5: Target Website & Offer"}
              {step === 6 && "Step 6: Review & Save"}
            </CardTitle>
            <CardDescription>
              {step === 1 && "Choose which Facebook account to use"}
              {step === 2 && "Pick the page that has the lead form"}
              {step === 3 && "Select the lead form to capture from"}
              {step === 4 && "Tell us which form fields contain name and phone"}
              {step === 5 && "Where should leads be sent, and with which offer?"}
              {step === 6 && "Review your configuration before saving"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* ── Step 1: Account ── */}
            {step === 1 && (
              <>
                {loadingAccounts ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading accounts...
                  </div>
                ) : !accounts?.length ? (
                  <div className="text-center py-6">
                    <p className="text-muted-foreground text-sm">No Facebook accounts connected.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => navigate("/facebook-accounts")}
                    >
                      Connect Account First
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {accounts.map((acct) => (
                      <button
                        key={acct.id}
                        onClick={() => set({ accountId: acct.id, accountName: acct.fbUserName })}
                        className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                          state.accountId === acct.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <div className="h-9 w-9 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                          <User className="h-4 w-4 text-blue-600" />
                        </div>
                        <div>
                          <p className="font-medium text-sm">{acct.fbUserName}</p>
                          <p className="text-xs text-muted-foreground">ID: {acct.fbUserId}</p>
                        </div>
                        {state.accountId === acct.id && (
                          <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ── Step 2: Page ── */}
            {step === 2 && (
              <>
                {loadingPages ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading pages from Facebook...
                  </div>
                ) : !pages?.length ? (
                  <p className="text-muted-foreground text-sm">
                    No pages found for this account. Make sure the account has pages_show_list permission.
                  </p>
                ) : (
                  <ScrollableList count={pages.length}>
                    {pages.map((page) => (
                      <button
                        key={page.id}
                        onClick={() => set({ pageId: page.id, pageName: page.name })}
                        className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                          state.pageId === page.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <div className="h-9 w-9 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                          <Facebook className="h-4 w-4 text-blue-600" />
                        </div>
                        <div>
                          <p className="font-medium text-sm">{page.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {page.category} · ID: {page.id}
                          </p>
                        </div>
                        {state.pageId === page.id && (
                          <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
                        )}
                      </button>
                    ))}
                  </ScrollableList>
                )}
              </>
            )}

            {/* ── Step 3: Form ── */}
            {step === 3 && (
              <>
                {loadingForms ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading lead forms...
                  </div>
                ) : !forms?.length ? (
                  <p className="text-muted-foreground text-sm">
                    No lead forms found on this page. Create a lead gen form in Facebook Ads Manager first.
                  </p>
                ) : (
                  <ScrollableList count={forms.length}>
                    {forms.map((form) => (
                      <button
                        key={form.id}
                        onClick={() => set({ formId: form.id, formName: form.name })}
                        className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                          state.formId === form.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                        <div>
                          <p className="font-medium text-sm">{form.name}</p>
                          <p className="text-xs text-muted-foreground">
                            ID: {form.id}
                            {form.status && ` · ${form.status}`}
                          </p>
                        </div>
                        {state.formId === form.id && (
                          <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
                        )}
                      </button>
                    ))}
                  </ScrollableList>
                )}
              </>
            )}

            {/* ── Step 4: Field Mapping ── */}
            {step === 4 && (
              <>
                {loadingFields ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading form fields...
                  </div>
                ) : !formFields?.length ? (
                  <p className="text-muted-foreground text-sm">
                    No fields found in this form.
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-md bg-muted/50 p-3 text-sm">
                      <p className="font-medium mb-1">Form fields available:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {formFields.map((f) => (
                          <Badge key={f.key} variant="outline" className="font-mono text-xs">
                            {f.key}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label>Full Name field</Label>
                        <Select
                          value={state.nameField}
                          onValueChange={(v) => set({ nameField: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select field for name..." />
                          </SelectTrigger>
                          <SelectContent>
                            {formFields.map((f) => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.key}{f.label ? ` — ${f.label}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Phone Number field</Label>
                        <Select
                          value={state.phoneField}
                          onValueChange={(v) => set({ phoneField: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select field for phone..." />
                          </SelectTrigger>
                          <SelectContent>
                            {formFields.map((f) => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.key}{f.label ? ` — ${f.label}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Step 5: Target Website & Variable Fields ── */}
            {step === 5 && (
              <div className="space-y-4">
                {loadingTargets ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading target websites...
                  </div>
                ) : !targetWebsites?.length ? (
                  <div className="text-center py-6 space-y-3">
                    <Globe className="h-10 w-10 text-muted-foreground mx-auto" />
                    <p className="text-muted-foreground text-sm">No target websites configured yet.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate("/target-websites")}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Target Website First
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Select Target Website</Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 px-2"
                        onClick={() => navigate("/target-websites")}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add New
                      </Button>
                    </div>
                    {/* Card list of target websites */}
                    <div className="grid gap-2">
                      {targetWebsites.map((site) => {
                        const isSelected = state.targetWebsiteId === site.id;
                        const tplLabel = site.templateType === "sotuvchi" ? "sotuvchi.com"
                          : site.templateType === "100k" ? "100k.uz"
                          : "Custom";
                        return (
                          <button
                            key={site.id}
                            onClick={() => {
                              set({
                                targetWebsiteId: site.id,
                                targetWebsiteName: site.name,
                                targetTemplateType: site.templateType ?? "custom",
                                variableFields: {},
                              });
                            }}
                            style={isSelected ? { borderColor: site.color, backgroundColor: `${site.color}10` } : {}}
                            className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                              isSelected
                                ? ""
                                : "hover:border-muted-foreground/40 hover:bg-muted/30"
                            }`}
                          >
                            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: site.color }}>
                              <Globe className="w-4 h-4 text-white" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm">{site.name}</p>
                              <p className="text-xs text-muted-foreground">{tplLabel}</p>
                            </div>
                            {isSelected && <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />}
                          </button>
                        );
                      })}
                    </div>

                    {/* Variable fields for selected template */}
                    {state.targetWebsiteId && (() => {
                      // For custom templates: auto-detected variables from body template
                      if (state.targetTemplateType === "custom") {
                        if (customVarNames.length === 0) return null;
                        return (
                          <div className="space-y-3 pt-2 border-t">
                            <p className="text-xs font-medium text-muted-foreground">
                              Custom variables detected in body template:
                            </p>
                            {customVarNames.map((varName) => (
                              <div key={varName} className="space-y-1.5">
                                <Label>
                                  <code className="bg-muted px-1 rounded text-xs">{`{{${varName}}}`}</code>
                                  <span className="text-destructive ml-1">*</span>
                                </Label>
                                <Input
                                  placeholder={`Value for {{${varName}}}`}
                                  value={state.variableFields[varName] ?? ""}
                                  onChange={(e) =>
                                    set({
                                      variableFields: {
                                        ...state.variableFields,
                                        [varName]: e.target.value,
                                      },
                                    })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        );
                      }
                      // For known templates: static variable field definitions
                      const vfDefs = TEMPLATE_VARIABLE_FIELDS[state.targetTemplateType] ?? [];
                      if (vfDefs.length === 0) return null;
                      return (
                        <div className="space-y-3 pt-2 border-t">
                          <p className="text-xs font-medium text-muted-foreground">
                            Routing-specific fields for this integration:
                          </p>
                          {vfDefs.map((vf) => (
                            <div key={vf.key} className="space-y-1.5">
                              <Label>
                                {vf.label}
                                {vf.required && <span className="text-destructive ml-1">*</span>}
                              </Label>
                              <Input
                                placeholder={vf.placeholder}
                                value={state.variableFields[vf.key] ?? ""}
                                onChange={(e) =>
                                  set({
                                    variableFields: {
                                      ...state.variableFields,
                                      [vf.key]: e.target.value,
                                    },
                                  })
                                }
                              />
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* ── Step 6: Review ── */}
            {step === 6 && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Integration Name (optional)</Label>
                  <Input
                    placeholder={`${state.pageName} → ${state.targetWebsiteName}`}
                    value={state.integrationName}
                    onChange={(e) => set({ integrationName: e.target.value })}
                  />
                </div>
                <div className="rounded-lg border divide-y text-sm">
                  {[
                    { label: "Facebook Account", value: state.accountName },
                    { label: "Page", value: `${state.pageName} (${state.pageId})` },
                    { label: "Lead Form", value: `${state.formName} (${state.formId})` },
                    { label: "Name Field", value: state.nameField },
                    { label: "Phone Field", value: state.phoneField },
                    { label: "Target Website", value: `${state.targetWebsiteName} (${state.targetTemplateType || "custom"})` },
                    ...Object.entries(state.variableFields).map(([k, v]) => ({ label: k, value: v })),
                  ].map((row) => (
                    <div key={row.label} className="flex justify-between px-3 py-2">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-medium text-right max-w-[60%] truncate">{row.value}</span>
                    </div>
                  ))}
                </div>
                <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-medium">What happens when you save:</p>
                  <ul className="list-disc list-inside mt-1 space-y-0.5 text-amber-700 dark:text-amber-400">
                    <li>The page will be subscribed to receive lead webhook events</li>
                    <li>New leads will be routed to the target website automatically</li>
                    <li>Name and phone will be extracted using your field mapping</li>
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Navigation */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => (step === 1 ? navigate("/integrations") : setStep(step - 1))}
            disabled={isSaving}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step < 6 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!canNext()}>
              Next
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  {isEditMode ? "Update & Subscribe" : "Save & Subscribe"}
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

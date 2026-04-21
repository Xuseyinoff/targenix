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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Facebook,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Search,
  Send,
  Tag,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import type { RouteComponentProps } from "wouter";

// ─── ScrollableList component ────────────────────────────────────────────────
// Each item is ~64px (p-3 + border + gap-2). 5 items ≈ 5 × 64 = 320px visible.
const ITEM_HEIGHT = 64; // px per item (approx)
const VISIBLE_ITEMS = 5;

function ScrollableList({
  children,
  count,
}: {
  children: React.ReactNode;
  count: number;
}) {
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
  const maxHeight = needsScroll
    ? ITEM_HEIGHT * VISIBLE_ITEMS + (VISIBLE_ITEMS - 1) * 8
    : undefined;

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

// ─── Step search input ────────────────────────────────────────────────────────

function StepSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative mb-3">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        className="pl-8 pr-8 h-8 text-sm"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
      />
      {value && (
        <button
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => onChange("")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Auto-match helpers ───────────────────────────────────────────────────────
// Constants + pure helpers live in ./lead-routing/shared.ts so the new
// stacked-card wizard (IntegrationWizardV2) can reuse identical serialisation
// semantics. Only UI-specific helpers remain in this file.

import {
  FB_METADATA_FIELDS,
  FB_METADATA_LABELS,
  NAME_PATTERNS,
  PHONE_PATTERNS,
  TEMPLATE_VARIABLE_FIELDS,
  autoMatchField,
  createEmptyExtraField,
  hydrateExtraFields,
  isKnownFormOrMetaFieldKey,
  serializeExtraFields,
  type ExtraFieldDraft,
} from "./lead-routing/shared";

/** Custom rows, or saved keys that are not in the form/metadata lists. */
function shouldUseManualSourceInput(
  field: ExtraFieldDraft,
  formFields: Array<{ key: string }>
): boolean {
  if (field.sourceType !== "form") return false;
  if (field.manualSource) return true;
  const k = field.sourceField?.trim() ?? "";
  return !!k && !isKnownFormOrMetaFieldKey(k, formFields);
}

function getSourceLabel(
  sourceField: string,
  formFields?: Array<{ key: string; label?: string }>
): string {
  const formField = formFields?.find(field => field.key === sourceField);
  if (formField) {
    return formField.label
      ? `${formField.label} (${formField.key})`
      : formField.key;
  }

  return FB_METADATA_LABELS[sourceField] ?? sourceField;
}

/** Radix Select only accepts values that exist in the list; custom typed keys stay in the Input only. */
function formFieldSelectValue(
  fieldKey: string,
  formFields: Array<{ key: string }>
): string | undefined {
  if (!fieldKey.trim()) return undefined;
  return formFields.some(f => f.key === fieldKey) ? fieldKey : undefined;
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
  extraFields: ExtraFieldDraft[];
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
  extraFields: [],
  targetWebsiteId: null,
  targetWebsiteName: "",
  targetTemplateType: "",
  variableFields: {},
  integrationName: "",
};

// TEMPLATE_VARIABLE_FIELDS moved to ./lead-routing/shared.ts (see import above).

const STEPS = [
  { id: 1, label: "Account", icon: User },
  { id: 2, label: "Page", icon: Facebook },
  { id: 3, label: "Form", icon: FileText },
  { id: 4, label: "Fields", icon: Tag },
  { id: 5, label: "Target", icon: Globe },
  { id: 6, label: "Review", icon: CheckCircle2 },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function LeadRoutingWizard({
  params,
}: RouteComponentProps<{ id?: string }>) {
  const editIntegrationId = params?.id ? parseInt(params.id, 10) : null;
  const isEditMode = !!editIntegrationId && !isNaN(editIntegrationId);
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [editLoaded, setEditLoaded] = useState(false);
  const [ignoreDuplicate, setIgnoreDuplicate] = useState(false);
  const [searchAccount, setSearchAccount] = useState("");
  const [searchPage, setSearchPage] = useState("");
  const [searchForm, setSearchForm] = useState("");
  const [searchTarget, setSearchTarget] = useState("");

  // Reset step searches when navigating away
  useEffect(() => {
    setSearchAccount("");
    setSearchPage("");
    setSearchForm("");
    setSearchTarget("");
  }, [step]);
  const utils = trpc.useUtils();

  const set = (patch: Partial<WizardState>) =>
    setState(s => ({ ...s, ...patch }));
  const updateExtraField = (index: number, patch: Partial<ExtraFieldDraft>) => {
    setState(current => {
      const next = [...current.extraFields];
      const existing = next[index];
      if (!existing) return current;

      const updated: ExtraFieldDraft = { ...existing, ...patch };
      if (patch.sourceType === "form") {
        updated.sourceField = updated.sourceField ?? "";
        updated.staticValue = "";
      }
      if (patch.sourceType === "static") {
        updated.staticValue = updated.staticValue ?? "";
        updated.sourceField = "";
      }
      if (patch.sourceField && !updated.destKey.trim()) {
        updated.destKey = patch.sourceField;
      }

      next[index] = updated;
      return { ...current, extraFields: next };
    });
  };
  const addExtraField = () =>
    setState(current => ({
      ...current,
      extraFields: [...current.extraFields, createEmptyExtraField()],
    }));
  const removeExtraField = (index: number) =>
    setState(current => ({
      ...current,
      extraFields: current.extraFields.filter(
        (_, currentIndex) => currentIndex !== index
      ),
    }));

  // ── Data queries ─────────────────────────────────────────────────────────
  const { data: accounts, isLoading: loadingAccounts } =
    trpc.facebookAccounts.list.useQuery();
  const { data: pages, isLoading: loadingPages } =
    trpc.facebookAccounts.listPages.useQuery(
      { accountId: state.accountId! },
      { enabled: !!state.accountId && step >= 2 }
    );
  const { data: forms, isLoading: loadingForms } =
    trpc.facebookAccounts.listForms.useQuery(
      { accountId: state.accountId!, pageId: state.pageId },
      { enabled: !!state.accountId && !!state.pageId && step >= 3 }
    );
  const { data: formFields, isLoading: loadingFields } =
    trpc.facebookAccounts.listFormFields.useQuery(
      {
        accountId: state.accountId!,
        pageId: state.pageId,
        formId: state.formId,
      },
      {
        enabled:
          !!state.accountId && !!state.pageId && !!state.formId && step >= 4,
      }
    );

  // Auto-select name/phone fields when formFields load
  useEffect(() => {
    if (!formFields?.length) return;
    const autoName = autoMatchField(formFields, NAME_PATTERNS);
    const autoPhone = autoMatchField(formFields, PHONE_PATTERNS);
    setState(current => ({
      ...current,
      nameField: current.nameField || autoName,
      phoneField: current.phoneField || autoPhone,
    }));
  }, [formFields]);
  const { data: targetWebsites, isLoading: loadingTargets } =
    trpc.targetWebsites.list.useQuery(undefined, { enabled: step >= 5 });

  // Admin-managed destination templates (for dynamic variableFields)
  const { data: destinationTemplates = [] } =
    trpc.targetWebsites.getTemplates.useQuery(undefined, { enabled: step >= 5 });

  // Auto-detect custom variables from the selected custom template's body
  const { data: customVarNames = [] } =
    trpc.targetWebsites.getCustomVariables.useQuery(
      { id: state.targetWebsiteId! },
      {
        enabled:
          step >= 5 &&
          !!state.targetWebsiteId &&
          state.targetTemplateType === "custom",
      }
    );

  // ── Load existing integration for edit mode ──────────────────────────────
  const { data: allIntegrations } = trpc.integrations.list.useQuery();
  // Duplicate detection: same pageId + formId already has a routing (excluding current edit)
  const duplicates = useMemo(() => {
    if (!allIntegrations || !state.formId || !state.pageId) return [];
    return allIntegrations.filter(
      i =>
        i.type === "LEAD_ROUTING" &&
        i.formId === state.formId &&
        i.pageId === state.pageId &&
        i.id !== editIntegrationId
    );
  }, [allIntegrations, state.formId, state.pageId, editIntegrationId]);

  const duplicateExtraDestKeys = useMemo(() => {
    const counts = new Map<string, number>();

    for (const field of state.extraFields) {
      const key = field.destKey.trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    );
  }, [state.extraFields]);

  const mappedExtraFields = useMemo(
    () => serializeExtraFields(state.extraFields),
    [state.extraFields]
  );

  // Reset ignoreDuplicate when form changes
  useEffect(() => {
    setIgnoreDuplicate(false);
  }, [state.formId]);

  useEffect(() => {
    if (!isEditMode || editLoaded || !allIntegrations) return;
    const found = allIntegrations.find(i => i.id === editIntegrationId);
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
      extraFields: hydrateExtraFields(cfg.extraFields),
      targetWebsiteId:
        found.targetWebsiteId ?? (cfg.targetWebsiteId as number) ?? null,
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
    onError: err => toast.error(err.message),
  });
  const createIntegration = trpc.integrations.create.useMutation({
    onSuccess: () => {
      toast.success("Integration created successfully!");
      utils.integrations.list.invalidate();
      navigate("/integrations");
    },
    onError: err => toast.error(err.message),
  });

  const handleSave = async () => {
    if (
      !state.accountId ||
      !state.pageId ||
      !state.formId ||
      !state.targetWebsiteId
    )
      return;
    const integrationConfig = {
      facebookAccountId: state.accountId,
      pageId: state.pageId,
      pageName: state.pageName,
      formId: state.formId,
      formName: state.formName,
      nameField: state.nameField,
      phoneField: state.phoneField,
      extraFields: mappedExtraFields,
      targetWebsiteId: state.targetWebsiteId,
      targetWebsiteName: state.targetWebsiteName,
      targetTemplateType: state.targetTemplateType,
      variableFields: state.variableFields,
    };
    const integrationName =
      state.integrationName || `${state.pageName} → ${state.targetWebsiteName}`;
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
      toast.error(
        err.message ??
          (isEditMode
            ? "Failed to update integration"
            : "Failed to create integration")
      );
    }
  };

  const canNext = () => {
    if (step === 1) return !!state.accountId;
    if (step === 2) return !!state.pageId;
    if (step === 3)
      return !!state.formId && (duplicates.length === 0 || ignoreDuplicate);
    if (step === 4) {
      return (
        !!state.nameField &&
        !!state.phoneField &&
        duplicateExtraDestKeys.size === 0 &&
        state.extraFields.every(
          field =>
            !field.destKey.trim() ||
            (field.sourceType === "form"
              ? !!field.sourceField
              : !!field.staticValue?.trim())
        )
      );
    }
    if (step === 5) {
      if (!state.targetWebsiteId) return false;
      // Telegram destinations need no variable fields
      if (state.targetTemplateType === "telegram") return true;
      if (state.targetTemplateType === "custom") {
        // For custom templates, all auto-detected variables must be filled
        return customVarNames.every(k => !!state.variableFields[k]?.trim());
      }
      const vfDefs = TEMPLATE_VARIABLE_FIELDS[state.targetTemplateType] ?? [];
      return vfDefs.every(
        vf => !vf.required || !!state.variableFields[vf.key]?.trim()
      );
    }
    return true;
  };

  const isSaving =
    subscribeMutation.isPending ||
    createIntegration.isPending ||
    updateIntegration.isPending;

  return (
    <DashboardLayout>
      <div className="max-w-2xl space-y-6">
        {/* Header */}
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2"
            onClick={() => navigate("/integrations")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Integrations
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">
            {isEditMode ? "Edit Lead Routing" : "New Lead Routing"}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isEditMode
              ? "Update your routing configuration"
              : "Connect a Facebook lead form to a target website in 6 steps"}
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
                  {done ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <Icon className="h-3 w-3" />
                  )}
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
              {step === 4 && "Step 4: Map Payload Fields"}
              {step === 5 && "Step 5: Target Website & Offer"}
              {step === 6 && "Step 6: Review & Save"}
            </CardTitle>
            <CardDescription>
              {step === 1 && "Choose which Facebook account to use"}
              {step === 2 && "Pick the page that has the lead form"}
              {step === 3 && "Select the lead form to capture from"}
              {step === 4 && "Map form fields to outbound payload keys"}
              {step === 5 &&
                "Where should leads be sent, and with which offer?"}
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
                    <p className="text-muted-foreground text-sm">
                      No Facebook accounts connected.
                    </p>
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
                  <>
                    {accounts.length > 3 && (
                      <StepSearch
                        value={searchAccount}
                        onChange={setSearchAccount}
                        placeholder="Search accounts..."
                      />
                    )}
                    <div className="grid gap-2">
                      {accounts
                        .filter(
                          a =>
                            !searchAccount ||
                            a.fbUserName
                              .toLowerCase()
                              .includes(searchAccount.toLowerCase())
                        )
                        .map(acct => (
                          <button
                            key={acct.id}
                            onClick={() =>
                              set({
                                accountId: acct.id,
                                accountName: acct.fbUserName,
                                pageId: "",
                                pageName: "",
                                formId: "",
                                formName: "",
                                nameField: "",
                                phoneField: "",
                                extraFields: [],
                              })
                            }
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
                              <p className="font-medium text-sm">
                                {acct.fbUserName}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                ID: {acct.fbUserId}
                              </p>
                            </div>
                            {state.accountId === acct.id && (
                              <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
                            )}
                          </button>
                        ))}
                      {searchAccount &&
                        !accounts.some(a =>
                          a.fbUserName
                            .toLowerCase()
                            .includes(searchAccount.toLowerCase())
                        ) && (
                          <p className="text-xs text-muted-foreground text-center py-3">
                            No accounts match "{searchAccount}"
                          </p>
                        )}
                    </div>
                  </>
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
                    No pages found for this account. Make sure the account has
                    pages_show_list permission.
                  </p>
                ) : (
                  (() => {
                    const filtered = pages.filter(
                      p =>
                        !searchPage ||
                        p.name.toLowerCase().includes(searchPage.toLowerCase())
                    );
                    return (
                      <>
                        <StepSearch
                          value={searchPage}
                          onChange={setSearchPage}
                          placeholder="Search pages..."
                        />
                        <ScrollableList count={filtered.length}>
                          {filtered.map(page => (
                            <button
                              key={page.id}
                              onClick={() =>
                                set({
                                  pageId: page.id,
                                  pageName: page.name,
                                  formId: "",
                                  formName: "",
                                  nameField: "",
                                  phoneField: "",
                                  extraFields: [],
                                })
                              }
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
                                <p className="font-medium text-sm">
                                  {page.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {page.category} · ID: {page.id}
                                </p>
                              </div>
                              {state.pageId === page.id && (
                                <CheckCircle2 className="h-4 w-4 text-primary ml-auto" />
                              )}
                            </button>
                          ))}
                          {filtered.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-3">
                              No pages match "{searchPage}"
                            </p>
                          )}
                        </ScrollableList>
                      </>
                    );
                  })()
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
                    No lead forms found on this page. Create a lead gen form in
                    Facebook Ads Manager first.
                  </p>
                ) : (
                  (() => {
                    const filtered = forms.filter(
                      f =>
                        !searchForm ||
                        f.name.toLowerCase().includes(searchForm.toLowerCase())
                    );
                    return (
                      <>
                        <StepSearch
                          value={searchForm}
                          onChange={setSearchForm}
                          placeholder={`Search ${forms.length} forms...`}
                        />
                        <ScrollableList count={filtered.length}>
                          {filtered.map(form => (
                            <button
                              key={form.id}
                              onClick={() =>
                                set({
                                  formId: form.id,
                                  formName: form.name,
                                  nameField: "",
                                  phoneField: "",
                                  extraFields: [],
                                })
                              }
                              className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                                state.formId === form.id
                                  ? "border-primary bg-primary/5"
                                  : "border-border hover:bg-muted/50"
                              }`}
                            >
                              <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                              <div>
                                <p className="font-medium text-sm">
                                  {form.name}
                                </p>
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
                          {filtered.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-3">
                              No forms match "{searchForm}"
                            </p>
                          )}
                        </ScrollableList>
                      </>
                    );
                  })()
                )}

                {/* Duplicate warning */}
                {duplicates.length > 0 && !ignoreDuplicate && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 p-3 space-y-2.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                          This form already has{" "}
                          {duplicates.length === 1
                            ? "an active routing"
                            : `${duplicates.length} active routings`}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                          Creating another routing for the same form will send
                          each lead to multiple destinations.
                        </p>
                      </div>
                    </div>

                    {/* Existing duplicates list */}
                    <div className="space-y-1.5">
                      {duplicates.map(dup => {
                        const cfg = dup.config as Record<string, unknown>;
                        return (
                          <div
                            key={dup.id}
                            className="flex items-center justify-between gap-2 bg-amber-100/60 dark:bg-amber-900/20 rounded-md px-2.5 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-amber-900 dark:text-amber-200 truncate">
                                {dup.name}
                              </p>
                              <p className="text-[11px] text-amber-700 dark:text-amber-400 truncate">
                                →{" "}
                                {String(
                                  (dup as { targetWebsiteName?: string })
                                    .targetWebsiteName ??
                                    cfg.targetWebsiteName ??
                                    "—"
                                )}
                                {!dup.isActive && " · Inactive"}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs shrink-0 border-amber-300 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200"
                              onClick={() =>
                                navigate(`/integrations/edit-routing/${dup.id}`)
                              }
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit existing
                            </Button>
                          </div>
                        );
                      })}
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs w-full text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                      onClick={() => setIgnoreDuplicate(true)}
                    >
                      Create new routing anyway
                    </Button>
                  </div>
                )}

                {/* "Creating another routing" confirmation badge */}
                {duplicates.length > 0 && ignoreDuplicate && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground flex-1">
                      Creating an additional routing alongside{" "}
                      {duplicates.length} existing one
                      {duplicates.length > 1 ? "s" : ""}
                    </p>
                    <button
                      className="text-[11px] underline text-muted-foreground hover:text-foreground"
                      onClick={() => setIgnoreDuplicate(false)}
                    >
                      Undo
                    </button>
                  </div>
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
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Full name and phone are auto-detected when possible. Pick a
                      form field or type the field key; clear a row with delete
                      if you need to remap.
                    </p>

                    {/* Full name — same row pattern as extra fields (source + key + delete) */}
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-lg border min-w-0">
                        <Select
                          value={formFieldSelectValue(
                            state.nameField,
                            formFields
                          )}
                          onValueChange={value => set({ nameField: value })}
                        >
                          <SelectTrigger className="border-0 shadow-none h-10 text-sm focus:ring-0">
                            <SelectValue placeholder="Full name — select source..." />
                          </SelectTrigger>
                          <SelectContent>
                            {formFields.map(f => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.label || f.key}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex-1 rounded-lg border min-w-0">
                        <Input
                          className="border-0 shadow-none h-10 text-sm focus-visible:ring-0 font-mono"
                          placeholder="value..."
                          value={state.nameField}
                          onChange={e => set({ nameField: e.target.value })}
                          autoComplete="off"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => set({ nameField: "" })}
                        className="h-10 w-8 shrink-0 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                        aria-label="Clear full name mapping"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Phone — same row pattern */}
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-lg border min-w-0">
                        <Select
                          value={formFieldSelectValue(
                            state.phoneField,
                            formFields
                          )}
                          onValueChange={value => set({ phoneField: value })}
                        >
                          <SelectTrigger className="border-0 shadow-none h-10 text-sm focus:ring-0">
                            <SelectValue placeholder="Phone — select source..." />
                          </SelectTrigger>
                          <SelectContent>
                            {formFields.map(f => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.label || f.key}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex-1 rounded-lg border min-w-0">
                        <Input
                          className="border-0 shadow-none h-10 text-sm focus-visible:ring-0 font-mono"
                          placeholder="value..."
                          value={state.phoneField}
                          onChange={e => set({ phoneField: e.target.value })}
                          autoComplete="off"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => set({ phoneField: "" })}
                        className="h-10 w-8 shrink-0 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                        aria-label="Clear phone mapping"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Extra field rows */}
                    {state.extraFields.map((field, index) => {
                      const trimmedDestKey = field.destKey.trim();
                      const isDuplicate =
                        !!trimmedDestKey &&
                        duplicateExtraDestKeys.has(trimmedDestKey);
                      const manualSourceLeft =
                        field.sourceType === "form" &&
                        shouldUseManualSourceInput(field, formFields);

                      return (
                        <div
                          key={`${index}-${field.sourceField || field.destKey || "new"}`}
                          className={`flex items-center gap-2${isDuplicate ? " rounded-lg p-0.5 ring-1 ring-destructive/40" : ""}`}
                        >
                          {/* Left block — static value, manual source key, or dropdown */}
                          <div className="flex-1 rounded-lg border min-w-0">
                            {field.sourceType === "static" ? (
                              <Input
                                className="border-0 shadow-none h-10 text-sm focus-visible:ring-0 font-mono"
                                placeholder="Static value..."
                                value={field.staticValue ?? ""}
                                onChange={e =>
                                  updateExtraField(index, {
                                    staticValue: e.target.value,
                                  })
                                }
                                autoComplete="off"
                              />
                            ) : manualSourceLeft ? (
                              <Input
                                className="border-0 shadow-none h-10 text-sm focus-visible:ring-0 font-mono"
                                placeholder="Source field key..."
                                value={field.sourceField ?? ""}
                                onChange={e =>
                                  updateExtraField(index, {
                                    sourceField: e.target.value,
                                    manualSource: true,
                                  })
                                }
                                autoComplete="off"
                              />
                            ) : (
                              <Select
                                value={
                                  field.sourceField &&
                                  isKnownFormOrMetaFieldKey(
                                    field.sourceField,
                                    formFields
                                  )
                                    ? field.sourceField
                                    : undefined
                                }
                                onValueChange={value =>
                                  updateExtraField(index, {
                                    sourceField: value,
                                    manualSource: false,
                                  })
                                }
                              >
                                <SelectTrigger className="border-0 shadow-none h-10 text-sm focus:ring-0">
                                  <SelectValue placeholder="Select source..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    <SelectLabel>Form fields</SelectLabel>
                                    {formFields.map(option => (
                                      <SelectItem
                                        key={option.key}
                                        value={option.key}
                                      >
                                        {option.label || option.key}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                  <SelectGroup>
                                    <SelectLabel>Facebook metadata</SelectLabel>
                                    {FB_METADATA_FIELDS.map(option => (
                                      <SelectItem
                                        key={option.key}
                                        value={option.key}
                                      >
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          {/* Right block — destination key (editable) */}
                          <div className="flex-1 rounded-lg border min-w-0">
                            <Input
                              className="border-0 shadow-none h-10 text-sm focus-visible:ring-0 font-mono"
                              placeholder="value..."
                              value={field.destKey}
                              onChange={e =>
                                updateExtraField(index, {
                                  destKey: e.target.value,
                                })
                              }
                            />
                          </div>

                          {/* Delete */}
                          <button
                            type="button"
                            onClick={() => removeExtraField(index)}
                            className="h-10 w-8 shrink-0 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      );
                    })}

                    {/* Add Field + Custom */}
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1.5"
                        onClick={addExtraField}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Custom
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs gap-1.5"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add Field
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="max-h-72 overflow-y-auto"
                        >
                          {formFields.length > 0 && (
                            <>
                              <DropdownMenuLabel className="text-xs font-semibold text-foreground">
                                Form fields
                              </DropdownMenuLabel>
                              {formFields.map(f => (
                                <DropdownMenuItem
                                  key={f.key}
                                  className="text-xs"
                                  onClick={() =>
                                    setState(current => ({
                                      ...current,
                                      extraFields: [
                                        ...current.extraFields,
                                        {
                                          destKey: f.key,
                                          sourceType: "form",
                                          sourceField: f.key,
                                          staticValue: "",
                                          manualSource: false,
                                        },
                                      ],
                                    }))
                                  }
                                >
                                  {f.label || f.key}
                                </DropdownMenuItem>
                              ))}
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuLabel className="text-xs font-semibold text-foreground">
                            Facebook metadata
                          </DropdownMenuLabel>
                          {FB_METADATA_FIELDS.map(f => (
                            <DropdownMenuItem
                              key={f.key}
                              className="text-xs"
                              onClick={() =>
                                setState(current => ({
                                  ...current,
                                  extraFields: [
                                    ...current.extraFields,
                                    {
                                      destKey: f.key,
                                      sourceType: "form",
                                      sourceField: f.key,
                                      staticValue: "",
                                      manualSource: false,
                                    },
                                  ],
                                }))
                              }
                            >
                              {f.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                    <p className="text-muted-foreground text-sm">
                      No destinations configured yet.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate("/destinations")}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Destination First
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Select Destination</Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 px-2"
                        onClick={() => navigate("/destinations")}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add New
                      </Button>
                    </div>
                    {/* Card list of target websites */}
                    {targetWebsites.length > 3 && (
                      <StepSearch
                        value={searchTarget}
                        onChange={setSearchTarget}
                        placeholder={`Search ${targetWebsites.length} destinations...`}
                      />
                    )}
                    <div className="grid gap-2">
                      {targetWebsites
                        .filter(
                          s =>
                            !searchTarget ||
                            s.name
                              .toLowerCase()
                              .includes(searchTarget.toLowerCase())
                        )
                        .map(site => {
                          const isSelected = state.targetWebsiteId === site.id;
                          const tplLabel =
                            site.templateType === "sotuvchi"
                              ? "sotuvchi.com"
                              : site.templateType === "100k"
                                ? "100k.uz"
                                : site.templateType === "telegram"
                                  ? "Telegram Bot"
                                  : "Custom";
                          return (
                            <button
                              key={site.id}
                              onClick={() => {
                                set({
                                  targetWebsiteId: site.id,
                                  targetWebsiteName: site.name,
                                  targetTemplateType:
                                    site.templateType ?? "custom",
                                  variableFields: {},
                                });
                              }}
                              style={
                                isSelected
                                  ? {
                                      borderColor: site.color,
                                      backgroundColor: `${site.color}10`,
                                    }
                                  : {}
                              }
                              className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                                isSelected
                                  ? ""
                                  : "hover:border-muted-foreground/40 hover:bg-muted/30"
                              }`}
                            >
                              <div
                                className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                                style={{ backgroundColor: site.color }}
                              >
                                {site.templateType === "telegram"
                                  ? <Send className="w-4 h-4 text-white" />
                                  : <Globe className="w-4 h-4 text-white" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm">
                                  {site.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {tplLabel}
                                </p>
                              </div>
                              {isSelected && (
                                <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      {searchTarget &&
                        !targetWebsites.some(s =>
                          s.name
                            .toLowerCase()
                            .includes(searchTarget.toLowerCase())
                        ) && (
                          <p className="text-xs text-muted-foreground text-center py-3">
                            No destinations match "{searchTarget}"
                          </p>
                        )}
                    </div>

                    {/* Variable fields for selected template */}
                    {state.targetWebsiteId &&
                      (() => {
                        // Telegram: no variable fields, show info instead
                        if (state.targetTemplateType === "telegram") {
                          return (
                            <div className="flex gap-2.5 rounded-lg border border-sky-200/80 bg-sky-50 p-3 dark:border-sky-800/60 dark:bg-sky-950/20">
                              <Send className="h-4 w-4 shrink-0 mt-0.5 text-sky-600 dark:text-sky-400" />
                              <p className="text-xs text-sky-900 dark:text-sky-200">
                                Leadlar avtomatik Telegram ga yuboriladi. Qo&apos;shimcha sozlash shart emas.
                              </p>
                            </div>
                          );
                        }

                        const selectedSite = targetWebsites?.find(s => s.id === state.targetWebsiteId);
                        const dynTemplateId = (selectedSite as { templateId?: number | null } | undefined)?.templateId;

                        // Dynamic admin-managed template: show its variableFields
                        if (dynTemplateId) {
                          const dynTpl = destinationTemplates.find(t => t.id === dynTemplateId);
                          const varFields = (dynTpl?.variableFields as string[] | undefined) ?? [];
                          if (varFields.length === 0) return null;
                          return (
                            <div className="space-y-3 pt-2 border-t">
                              <p className="text-xs font-medium text-muted-foreground">
                                Routing-specific fields for this integration:
                              </p>
                              {varFields.map(key => (
                                <div key={key} className="space-y-1.5">
                                  <Label>
                                    {key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                                    <span className="text-destructive ml-1">*</span>
                                  </Label>
                                  <Input
                                    placeholder={`Enter ${key}`}
                                    value={state.variableFields[key] ?? ""}
                                    onChange={e =>
                                      set({ variableFields: { ...state.variableFields, [key]: e.target.value } })
                                    }
                                  />
                                </div>
                              ))}
                            </div>
                          );
                        }

                        // For custom templates: auto-detected variables from body template
                        if (state.targetTemplateType === "custom") {
                          if (customVarNames.length === 0) return null;
                          return (
                            <div className="space-y-3 pt-2 border-t">
                              <p className="text-xs font-medium text-muted-foreground">
                                Custom variables detected in body template:
                              </p>
                              {customVarNames.map(varName => (
                                <div key={varName} className="space-y-1.5">
                                  <Label>
                                    <code className="bg-muted px-1 rounded text-xs">{`{{${varName}}}`}</code>
                                    <span className="text-destructive ml-1">
                                      *
                                    </span>
                                  </Label>
                                  <Input
                                    placeholder={`Value for {{${varName}}}`}
                                    value={state.variableFields[varName] ?? ""}
                                    onChange={e =>
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
                        // For known legacy templates: static variable field definitions
                        const vfDefs =
                          TEMPLATE_VARIABLE_FIELDS[state.targetTemplateType] ??
                          [];
                        if (vfDefs.length === 0) return null;
                        return (
                          <div className="space-y-3 pt-2 border-t">
                            <p className="text-xs font-medium text-muted-foreground">
                              Routing-specific fields for this integration:
                            </p>
                            {vfDefs.map(vf => (
                              <div key={vf.key} className="space-y-1.5">
                                <Label>
                                  {vf.label}
                                  {vf.required && (
                                    <span className="text-destructive ml-1">
                                      *
                                    </span>
                                  )}
                                </Label>
                                <Input
                                  placeholder={vf.placeholder}
                                  value={state.variableFields[vf.key] ?? ""}
                                  onChange={e =>
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
                    onChange={e => set({ integrationName: e.target.value })}
                  />
                </div>
                <div className="rounded-lg border divide-y text-sm">
                  {[
                    { label: "Facebook Account", value: state.accountName },
                    {
                      label: "Page",
                      value: `${state.pageName} (${state.pageId})`,
                    },
                    {
                      label: "Lead Form",
                      value: `${state.formName} (${state.formId})`,
                    },
                    {
                      label: "Full Name Source",
                      value: getSourceLabel(state.nameField, formFields),
                    },
                    {
                      label: "Phone Source",
                      value: getSourceLabel(state.phoneField, formFields),
                    },
                    ...mappedExtraFields.map(field => ({
                      label: `Extra • ${field.destKey}`,
                      value:
                        field.staticValue !== undefined
                          ? `"${field.staticValue}"`
                          : getSourceLabel(field.sourceField ?? "", formFields),
                    })),
                    {
                      label: "Target Website",
                      value: `${state.targetWebsiteName} (${state.targetTemplateType || "custom"})`,
                    },
                    ...Object.entries(state.variableFields).map(([k, v]) => ({
                      label: k,
                      value: v,
                    })),
                  ].map(row => (
                    <div
                      key={row.label}
                      className="flex justify-between px-3 py-2"
                    >
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-medium text-right max-w-[60%] truncate">
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-medium">What happens when you save:</p>
                  <ul className="list-disc list-inside mt-1 space-y-0.5 text-amber-700 dark:text-amber-400">
                    <li>
                      The page will be subscribed to receive lead webhook events
                    </li>
                    <li>
                      New leads will be routed to the target website
                      automatically
                    </li>
                    <li>
                      Name, phone, and any extra fields will be resolved using
                      your mapping rules
                    </li>
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
            onClick={() =>
              step === 1 ? navigate("/integrations") : setStep(step - 1)
            }
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

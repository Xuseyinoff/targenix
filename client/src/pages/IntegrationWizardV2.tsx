/**
 * IntegrationWizardV2 — Make.com-style stacked-card wizard for creating a
 * LEAD_ROUTING integration.
 *
 * Mounted at /integrations/new-v2 and gated behind the multi_destinations
 * feature flag (see server/services/featureFlags.ts). Users who aren't opted
 * in go through the legacy stepped wizard at /integrations/new-routing — we
 * keep both paths alive through Commit 5 so the new UI can iterate without
 * blocking anyone.
 *
 * The wizard persists the EXACT same integration.config shape as the legacy
 * wizard, so existing leads/orders/retries logic keeps working unchanged:
 *   { facebookAccountId, pageId, pageName, formId, formName, nameField,
 *     phoneField, extraFields, targetWebsiteId, targetWebsiteName,
 *     targetTemplateType, variableFields }
 *
 * 5b scope (this commit):
 *   - Trigger card: Facebook account / page / form
 *   - Destination card: pick an EXISTING target_website (grouped by category)
 *   - Mapping card: auto-detected name/phone + extra fields (form | static)
 *   - Variables card: template-specific variables (sotuvchi, 100k, custom)
 *   - Name card: auto-generated, editable
 * 5c will bring multi-destination fan-out and inline destination creation.
 */

import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  Facebook,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Tag,
  Trash2,
  Type,
  User,
  Webhook,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  FB_METADATA_FIELDS,
  FB_METADATA_LABELS,
  NAME_PATTERNS,
  PHONE_PATTERNS,
  TEMPLATE_VARIABLE_FIELDS,
  autoMatchField,
  createEmptyExtraField,
  serializeExtraFields,
  type ExtraFieldDraft,
} from "./lead-routing/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WizardState {
  // Trigger
  accountId: number | null;
  accountName: string;
  pageId: string;
  pageName: string;
  formId: string;
  formName: string;
  // Destination
  targetWebsiteId: number | null;
  targetWebsiteName: string;
  targetTemplateType: string;
  // Mapping
  nameField: string;
  phoneField: string;
  extraFields: ExtraFieldDraft[];
  variableFields: Record<string, string>;
  // Meta
  integrationName: string;
}

const INITIAL_STATE: WizardState = {
  accountId: null,
  accountName: "",
  pageId: "",
  pageName: "",
  formId: "",
  formName: "",
  targetWebsiteId: null,
  targetWebsiteName: "",
  targetTemplateType: "",
  nameField: "",
  phoneField: "",
  extraFields: [],
  variableFields: {},
  integrationName: "",
};

// ─── Destination category metadata ────────────────────────────────────────────

type DestinationCategory = "messaging" | "data" | "webhooks" | "affiliate" | "crm";

const CATEGORY_META: Record<
  DestinationCategory,
  { label: string; icon: typeof MessageSquare; colorClass: string }
> = {
  messaging: {
    label: "Messaging",
    icon: MessageSquare,
    colorClass: "text-sky-600 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-400",
  },
  data: {
    label: "Spreadsheets & Data",
    icon: FileText,
    colorClass: "text-green-600 bg-green-50 dark:bg-green-950/40 dark:text-green-400",
  },
  webhooks: {
    label: "Custom Webhooks",
    icon: Webhook,
    colorClass: "text-violet-600 bg-violet-50 dark:bg-violet-950/40 dark:text-violet-400",
  },
  affiliate: {
    label: "Affiliate / CRM",
    icon: Globe,
    colorClass: "text-orange-600 bg-orange-50 dark:bg-orange-950/40 dark:text-orange-400",
  },
  crm: {
    label: "CRM",
    icon: Globe,
    colorClass: "text-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 dark:text-indigo-400",
  },
};

function iconForCategory(category: string) {
  const meta = CATEGORY_META[category as DestinationCategory];
  return meta?.icon ?? Globe;
}

function colorForCategory(category: string) {
  return (
    CATEGORY_META[category as DestinationCategory]?.colorClass ??
    CATEGORY_META.affiliate.colorClass
  );
}

// ─── Reusable card chrome ─────────────────────────────────────────────────────

interface WizardCardProps {
  stepNumber: number;
  title: string;
  description?: string;
  status: "locked" | "empty" | "filled";
  summary?: React.ReactNode;
  /** When true card renders expanded regardless of status. */
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Icon shown in the left rail. */
  icon?: typeof Zap;
}

function WizardCard({
  stepNumber,
  title,
  description,
  status,
  summary,
  open,
  onToggle,
  children,
  icon: IconComp,
}: WizardCardProps) {
  const isLocked = status === "locked";
  const isFilled = status === "filled";
  const StatusIcon = isFilled ? CheckCircle2 : isLocked ? Circle : Circle;

  return (
    <Card
      className={cn(
        "overflow-hidden transition-colors",
        isLocked && "opacity-50",
        open && "ring-1 ring-primary/20",
      )}
    >
      <button
        type="button"
        disabled={isLocked}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-3 p-4 text-left",
          !isLocked && "hover:bg-muted/30",
        )}
        aria-expanded={open}
      >
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2",
            isFilled
              ? "border-primary bg-primary/10 text-primary"
              : "border-muted-foreground/30 text-muted-foreground",
          )}
        >
          {IconComp ? (
            <IconComp className="h-4 w-4" />
          ) : (
            <span className="text-sm font-semibold">{stepNumber}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold truncate">{title}</h3>
            <StatusIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                isFilled ? "text-primary" : "text-muted-foreground/40",
              )}
            />
          </div>
          {!open && summary ? (
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              {summary}
            </div>
          ) : description ? (
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          ) : null}
        </div>
        <ChevronDown
          className={cn(
            "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t bg-muted/10 p-4 space-y-3">{children}</div>
      )}
    </Card>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function IntegrationWizardV2() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [state, setState] = useState<WizardState>(INITIAL_STATE);

  // Which card is currently expanded. We track a single open card at a time so
  // the UI stays focused. Users can always click back to a previous card.
  const [openCard, setOpenCard] = useState<
    "trigger" | "destination" | "mapping" | "name" | null
  >("trigger");

  // ─── Flag gate ─────────────────────────────────────────────────────────────
  const { data: flags, isLoading: flagsLoading } =
    trpc.system.featureFlags.useQuery();
  const isAllowed = flags?.multiDestinations ?? false;

  // ─── tRPC data queries ─────────────────────────────────────────────────────
  const { data: accounts, isLoading: loadingAccounts } =
    trpc.facebookAccounts.list.useQuery(undefined, { enabled: isAllowed });

  const { data: pages, isLoading: loadingPages } =
    trpc.facebookAccounts.listPages.useQuery(
      { accountId: state.accountId ?? 0 },
      { enabled: isAllowed && !!state.accountId },
    );

  const { data: forms, isLoading: loadingForms } =
    trpc.facebookAccounts.listForms.useQuery(
      { accountId: state.accountId ?? 0, pageId: state.pageId },
      { enabled: isAllowed && !!state.accountId && !!state.pageId },
    );

  const { data: formFields, isLoading: loadingFields } =
    trpc.facebookAccounts.listFormFields.useQuery(
      {
        accountId: state.accountId ?? 0,
        pageId: state.pageId,
        formId: state.formId,
      },
      { enabled: isAllowed && !!state.accountId && !!state.pageId && !!state.formId },
    );

  const { data: targetWebsites, isLoading: loadingTargets } =
    trpc.targetWebsites.list.useQuery(undefined, { enabled: isAllowed });

  const { data: customVarNames = [] } =
    trpc.targetWebsites.getCustomVariables.useQuery(
      { id: state.targetWebsiteId ?? 0 },
      {
        enabled:
          isAllowed &&
          !!state.targetWebsiteId &&
          state.targetTemplateType === "custom",
      },
    );

  // ─── Mutations ─────────────────────────────────────────────────────────────
  const subscribeMutation = trpc.facebookAccounts.subscribePage.useMutation();
  const createMutation = trpc.integrations.create.useMutation({
    onSuccess: () => {
      toast.success("Integration created successfully!");
      utils.integrations.list.invalidate();
      navigate("/integrations");
    },
    onError: (err) => toast.error(err.message),
  });

  // ─── Auto-fill: name/phone fields when form fields load ────────────────────
  useEffect(() => {
    if (!formFields?.length) return;
    const autoName = autoMatchField(formFields, NAME_PATTERNS);
    const autoPhone = autoMatchField(formFields, PHONE_PATTERNS);
    setState((s) => ({
      ...s,
      nameField: s.nameField || autoName,
      phoneField: s.phoneField || autoPhone,
    }));
  }, [formFields]);

  // ─── Auto-fill: integration name once page + destination are chosen ─────────
  useEffect(() => {
    if (state.integrationName.trim()) return; // user has typed something
    if (state.pageName && state.targetWebsiteName) {
      setState((s) => ({
        ...s,
        integrationName: `${state.pageName} → ${state.targetWebsiteName}`,
      }));
    }
  }, [state.pageName, state.targetWebsiteName, state.integrationName]);

  // ─── Auto-fill: seed variableFields with empty placeholders for custom ────
  // templates so the mapping card has something to render. Existing values
  // are preserved — we only fill in keys that aren't there yet.
  useEffect(() => {
    if (state.targetTemplateType !== "custom") return;
    if (!customVarNames.length) return;
    setState((s) => {
      const next = { ...s.variableFields };
      let changed = false;
      for (const key of customVarNames) {
        if (next[key] === undefined) {
          next[key] = "";
          changed = true;
        }
      }
      return changed ? { ...s, variableFields: next } : s;
    });
  }, [customVarNames, state.targetTemplateType]);

  // ─── Derived: variables required by the chosen destination template ────────
  const requiredVarKeys = useMemo(() => {
    if (state.targetTemplateType === "telegram") return [] as string[];
    if (state.targetTemplateType === "custom") return customVarNames;
    const defs = TEMPLATE_VARIABLE_FIELDS[state.targetTemplateType] ?? [];
    return defs.filter((d) => d.required).map((d) => d.key);
  }, [state.targetTemplateType, customVarNames]);

  // ─── Validation ────────────────────────────────────────────────────────────
  const triggerFilled =
    !!state.accountId && !!state.pageId && !!state.formId;
  const destinationFilled = !!state.targetWebsiteId;
  const mappingFilled =
    !!state.nameField &&
    !!state.phoneField &&
    requiredVarKeys.every((k) => !!state.variableFields[k]?.trim()) &&
    state.extraFields.every(
      (f) =>
        !f.destKey.trim() ||
        (f.sourceType === "form" ? !!f.sourceField : !!f.staticValue?.trim()),
    );
  const nameFilled = !!state.integrationName.trim();

  const canSave =
    triggerFilled && destinationFilled && mappingFilled && nameFilled;

  // ─── Card status helpers ───────────────────────────────────────────────────
  const triggerStatus: "empty" | "filled" = triggerFilled ? "filled" : "empty";
  const destinationStatus: "locked" | "empty" | "filled" = !triggerFilled
    ? "locked"
    : destinationFilled
      ? "filled"
      : "empty";
  const mappingStatus: "locked" | "empty" | "filled" =
    !triggerFilled || !destinationFilled
      ? "locked"
      : mappingFilled
        ? "filled"
        : "empty";
  const nameStatus: "locked" | "empty" | "filled" = !mappingFilled
    ? "locked"
    : nameFilled
      ? "filled"
      : "empty";

  // ─── State patches ─────────────────────────────────────────────────────────
  const patch = (p: Partial<WizardState>) => setState((s) => ({ ...s, ...p }));

  const setAccount = (id: number, name: string) => {
    patch({
      accountId: id,
      accountName: name,
      pageId: "",
      pageName: "",
      formId: "",
      formName: "",
      nameField: "",
      phoneField: "",
      extraFields: [],
    });
  };
  const setPage = (id: string, name: string) => {
    patch({
      pageId: id,
      pageName: name,
      formId: "",
      formName: "",
      nameField: "",
      phoneField: "",
      extraFields: [],
    });
  };
  const setForm = (id: string, name: string) => {
    // Changing the form invalidates any previous name/phone auto-match and any
    // extras the user may have configured against the old field set.
    patch({
      formId: id,
      formName: name,
      nameField: "",
      phoneField: "",
      extraFields: [],
    });
    // After selecting form, auto-advance to destination card for momentum.
    setOpenCard("destination");
  };
  const setDestination = (
    id: number,
    name: string,
    templateType: string,
  ) => {
    patch({
      targetWebsiteId: id,
      targetWebsiteName: name,
      targetTemplateType: templateType,
      variableFields: {}, // reset — new template may have different vars
    });
    setOpenCard("mapping");
  };

  const addExtra = () =>
    setState((s) => ({
      ...s,
      extraFields: [...s.extraFields, createEmptyExtraField()],
    }));
  const updateExtra = (index: number, p: Partial<ExtraFieldDraft>) =>
    setState((s) => {
      const next = [...s.extraFields];
      const existing = next[index];
      if (!existing) return s;
      const updated: ExtraFieldDraft = { ...existing, ...p };
      if (p.sourceType === "form") updated.staticValue = "";
      if (p.sourceType === "static") updated.sourceField = "";
      next[index] = updated;
      return { ...s, extraFields: next };
    });
  const removeExtra = (index: number) =>
    setState((s) => ({
      ...s,
      extraFields: s.extraFields.filter((_, i) => i !== index),
    }));

  // ─── Save handler ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!canSave) return;
    const config = {
      facebookAccountId: state.accountId,
      pageId: state.pageId,
      pageName: state.pageName,
      formId: state.formId,
      formName: state.formName,
      nameField: state.nameField,
      phoneField: state.phoneField,
      extraFields: serializeExtraFields(state.extraFields),
      targetWebsiteId: state.targetWebsiteId,
      targetWebsiteName: state.targetWebsiteName,
      targetTemplateType: state.targetTemplateType,
      variableFields: state.variableFields,
    };
    try {
      if (state.accountId && state.pageId) {
        await subscribeMutation.mutateAsync({
          accountId: state.accountId,
          pageId: state.pageId,
        });
      }
      await createMutation.mutateAsync({
        type: "LEAD_ROUTING",
        name: state.integrationName.trim(),
        config,
      });
    } catch (err) {
      // toasts are already surfaced by the mutation's onError callback.
      console.error("[IntegrationWizardV2] save failed", err);
    }
  };

  const isSaving = subscribeMutation.isPending || createMutation.isPending;

  // ─── Flag gate fallback ────────────────────────────────────────────────────
  if (flagsLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }
  if (!isAllowed) {
    return (
      <DashboardLayout>
        <div className="max-w-xl mx-auto py-12 text-center space-y-4">
          <Sparkles className="h-10 w-10 mx-auto text-muted-foreground" />
          <h1 className="text-xl font-semibold">New wizard (beta)</h1>
          <p className="text-sm text-muted-foreground">
            This redesigned integration wizard is currently rolling out to
            selected accounts. You can continue using the existing wizard
            without any changes.
          </p>
          <div className="flex gap-2 justify-center">
            <Button
              variant="outline"
              onClick={() => navigate("/integrations")}
            >
              Back to integrations
            </Button>
            <Button onClick={() => navigate("/integrations/new-routing")}>
              Open classic wizard
            </Button>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-4 pb-24">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/integrations")}
            className="h-8 -ml-2"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Integrations
          </Button>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">New integration</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-lg">
              Connect a Facebook Lead Ads form to a destination. Leads will be
              delivered in real time as they arrive.
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border bg-primary/10 text-primary px-2 py-1 text-[11px] font-medium shrink-0">
            <Sparkles className="h-3 w-3" />
            Beta
          </span>
        </div>

        {/* Card 1 — Trigger */}
        <WizardCard
          stepNumber={1}
          icon={Facebook}
          title="Trigger — Facebook Lead Ads"
          description="Which Facebook form should we watch for new leads?"
          status={triggerStatus}
          open={openCard === "trigger"}
          onToggle={() =>
            setOpenCard(openCard === "trigger" ? null : "trigger")
          }
          summary={
            triggerFilled
              ? `${state.pageName} / ${state.formName}`
              : "Not configured yet"
          }
        >
          <TriggerEditor
            accounts={accounts ?? []}
            loadingAccounts={loadingAccounts}
            pages={pages ?? []}
            loadingPages={loadingPages}
            forms={forms ?? []}
            loadingForms={loadingForms}
            state={state}
            onPickAccount={setAccount}
            onPickPage={setPage}
            onPickForm={setForm}
          />
        </WizardCard>

        {/* Card 2 — Destination */}
        <WizardCard
          stepNumber={2}
          icon={Send}
          title="Destination"
          description="Where should the lead be delivered?"
          status={destinationStatus}
          open={openCard === "destination"}
          onToggle={() =>
            setOpenCard(openCard === "destination" ? null : "destination")
          }
          summary={
            destinationFilled
              ? state.targetWebsiteName
              : "Pick a destination"
          }
        >
          <DestinationEditor
            destinations={targetWebsites ?? []}
            loading={loadingTargets}
            selectedId={state.targetWebsiteId}
            onPick={setDestination}
          />
        </WizardCard>

        {/* Card 3 — Mapping */}
        <WizardCard
          stepNumber={3}
          icon={Tag}
          title="Field mapping"
          description="Match the form fields to the destination, and fill in any required variables."
          status={mappingStatus}
          open={openCard === "mapping"}
          onToggle={() =>
            setOpenCard(openCard === "mapping" ? null : "mapping")
          }
          summary={
            mappingFilled
              ? `Name → ${state.nameField}, Phone → ${state.phoneField}${
                  state.extraFields.length
                    ? `, +${
                        state.extraFields.filter((f) => f.destKey.trim()).length
                      } extra`
                    : ""
                }`
              : "Not complete"
          }
        >
          <MappingEditor
            formFields={formFields ?? []}
            loadingFields={loadingFields}
            state={state}
            onPatch={patch}
            onAddExtra={addExtra}
            onUpdateExtra={updateExtra}
            onRemoveExtra={removeExtra}
          />
        </WizardCard>

        {/* Card 4 — Name */}
        <WizardCard
          stepNumber={4}
          icon={Type}
          title="Integration name"
          description="How it appears on your dashboard."
          status={nameStatus}
          open={openCard === "name"}
          onToggle={() => setOpenCard(openCard === "name" ? null : "name")}
          summary={
            nameFilled ? state.integrationName : "Auto-generated from page → destination"
          }
        >
          <div className="space-y-2">
            <Label htmlFor="integration-name" className="text-xs">
              Name
            </Label>
            <Input
              id="integration-name"
              value={state.integrationName}
              onChange={(e) => patch({ integrationName: e.target.value })}
              placeholder={
                state.pageName && state.targetWebsiteName
                  ? `${state.pageName} → ${state.targetWebsiteName}`
                  : "My integration"
              }
            />
          </div>
        </WizardCard>

        {/* Footer — sticky save bar */}
        <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur border-t z-10">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {canSave
                ? "Ready to save. Activates immediately."
                : "Fill in the highlighted cards to continue."}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/integrations")}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!canSave || isSaving}
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-1.5" />
                )}
                Save & activate
              </Button>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

// ─── TriggerEditor ────────────────────────────────────────────────────────────

interface TriggerAccount {
  id: number;
  fbUserName: string;
  fbUserId: string;
}
interface TriggerPage {
  id: string;
  name: string;
}
interface TriggerForm {
  id: string;
  name: string;
  status?: string | null;
}

interface TriggerEditorProps {
  accounts: ReadonlyArray<TriggerAccount>;
  loadingAccounts: boolean;
  pages: ReadonlyArray<TriggerPage>;
  loadingPages: boolean;
  forms: ReadonlyArray<TriggerForm>;
  loadingForms: boolean;
  state: WizardState;
  onPickAccount: (id: number, name: string) => void;
  onPickPage: (id: string, name: string) => void;
  onPickForm: (id: string, name: string) => void;
}

function TriggerEditor({
  accounts,
  loadingAccounts,
  pages,
  loadingPages,
  forms,
  loadingForms,
  state,
  onPickAccount,
  onPickPage,
  onPickForm,
}: TriggerEditorProps) {
  return (
    <div className="space-y-3">
      {/* Account */}
      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1.5">
          <User className="h-3 w-3" /> Facebook account
        </Label>
        {loadingAccounts ? (
          <LoadingBar />
        ) : accounts.length === 0 ? (
          <EmptyHint
            message="No Facebook accounts connected yet."
            ctaLabel="Connect Facebook"
            href="/facebook-accounts"
          />
        ) : (
          <Select
            value={state.accountId ? String(state.accountId) : undefined}
            onValueChange={(v) => {
              const acc = accounts.find((a) => a.id === Number(v));
              if (acc) onPickAccount(acc.id, acc.fbUserName);
            }}
          >
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.fbUserName || `Account #${a.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Page */}
      {state.accountId && (
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1.5">
            <Facebook className="h-3 w-3" /> Page
          </Label>
          {loadingPages ? (
            <LoadingBar />
          ) : pages.length === 0 ? (
            <EmptyHint message="This account has no accessible pages." />
          ) : (
            <Select
              value={state.pageId || undefined}
              onValueChange={(v) => {
                const p = pages.find((x) => x.id === v);
                if (p) onPickPage(p.id, p.name);
              }}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select page" />
              </SelectTrigger>
              <SelectContent>
                {pages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Form */}
      {state.pageId && (
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1.5">
            <FileText className="h-3 w-3" /> Lead form
          </Label>
          {loadingForms ? (
            <LoadingBar />
          ) : forms.length === 0 ? (
            <EmptyHint message="No active lead forms on this page." />
          ) : (
            <Select
              value={state.formId || undefined}
              onValueChange={(v) => {
                const f = forms.find((x) => x.id === v);
                if (f) onPickForm(f.id, f.name);
              }}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select form" />
              </SelectTrigger>
              <SelectContent>
                {forms.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                    {f.status ? ` · ${f.status}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DestinationEditor ────────────────────────────────────────────────────────

interface DestinationListItem {
  id: number;
  name: string;
  templateType: string;
  templateName?: string | null;
  category: string;
}

interface DestinationEditorProps {
  destinations: DestinationListItem[];
  loading: boolean;
  selectedId: number | null;
  onPick: (id: number, name: string, templateType: string) => void;
}

function DestinationEditor({
  destinations,
  loading,
  selectedId,
  onPick,
}: DestinationEditorProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, DestinationListItem[]>();
    for (const d of destinations) {
      const arr = map.get(d.category) ?? [];
      arr.push(d);
      map.set(d.category, arr);
    }
    return Array.from(map.entries());
  }, [destinations]);

  if (loading) return <LoadingBar />;
  if (destinations.length === 0) {
    return (
      <EmptyHint
        message="You haven't created any destinations yet."
        ctaLabel="Create destination"
        href="/target-websites"
      />
    );
  }

  return (
    <div className="space-y-3">
      {grouped.map(([category, items]) => {
        const Icon = iconForCategory(category);
        const color = colorForCategory(category);
        const meta = CATEGORY_META[category as DestinationCategory];
        return (
          <div key={category} className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {meta?.label ?? category}
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {items.map((d) => {
                const isSelected = selectedId === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onPick(d.id, d.name, d.templateType)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md border bg-background p-2.5 text-left text-sm transition-colors",
                      isSelected
                        ? "border-primary ring-1 ring-primary/30 bg-primary/5"
                        : "hover:border-primary/40 hover:bg-muted/30",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                        color,
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {d.templateName || d.templateType}
                      </div>
                    </div>
                    {isSelected && (
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => window.open("/target-websites", "_blank")}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Create new destination
          <ArrowRight className="h-3 w-3 ml-1.5 opacity-60" />
        </Button>
        <p className="text-[11px] text-muted-foreground mt-1">
          Opens destinations in a new tab — return here when done to pick it.
        </p>
      </div>
    </div>
  );
}

// ─── MappingEditor ────────────────────────────────────────────────────────────

interface MappingEditorProps {
  formFields: Array<{ key: string; label?: string | null }>;
  loadingFields: boolean;
  state: WizardState;
  onPatch: (p: Partial<WizardState>) => void;
  onAddExtra: () => void;
  onUpdateExtra: (index: number, p: Partial<ExtraFieldDraft>) => void;
  onRemoveExtra: (index: number) => void;
}

function MappingEditor({
  formFields,
  loadingFields,
  state,
  onPatch,
  onAddExtra,
  onUpdateExtra,
  onRemoveExtra,
}: MappingEditorProps) {
  const templateDefs = TEMPLATE_VARIABLE_FIELDS[state.targetTemplateType] ?? [];
  const isCustom = state.targetTemplateType === "custom";
  const isTelegram = state.targetTemplateType === "telegram";

  // Compute a client-side equivalent of customVarNames from parent. In this
  // child we receive them indirectly via state — MappingEditor reads
  // state.variableFields to know which keys are already filled. The parent
  // actually owns the variableFields/customVarNames lifecycle.
  //
  // We keep the rendering local: iterate known defs OR — for custom — iterate
  // the currently-known variable keys. The parent will re-render once
  // customVarNames arrives and updates state.
  const variableEntries = useMemo(() => {
    if (isTelegram) return [];
    if (isCustom) {
      return Object.keys(state.variableFields).map((k) => ({
        key: k,
        label: k,
        placeholder: `Value for ${k}`,
        required: true,
      }));
    }
    return templateDefs;
  }, [isTelegram, isCustom, templateDefs, state.variableFields]);

  if (loadingFields) return <LoadingBar />;
  if (formFields.length === 0) {
    return (
      <EmptyHint message="The selected form has no fields yet. Try a different form or check the Facebook form's status." />
    );
  }

  return (
    <div className="space-y-4">
      {/* Name + phone */}
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldSelect
          label="Name field"
          value={state.nameField}
          formFields={formFields}
          onChange={(v) => onPatch({ nameField: v })}
          placeholder="Pick the lead's name field"
        />
        <FieldSelect
          label="Phone field"
          value={state.phoneField}
          formFields={formFields}
          onChange={(v) => onPatch({ phoneField: v })}
          placeholder="Pick the lead's phone field"
        />
      </div>

      {/* Variable fields for chosen template */}
      {variableEntries.length > 0 && (
        <div className="space-y-2 rounded-md border bg-background p-3">
          <div className="text-xs font-semibold">
            Destination variables
            <span className="ml-1.5 text-muted-foreground font-normal">
              ({state.targetWebsiteName})
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {variableEntries.map((v) => (
              <div key={v.key} className="space-y-1">
                <Label className="text-xs">
                  {v.label}
                  {v.required && <span className="text-destructive"> *</span>}
                </Label>
                <Input
                  className="h-8 text-sm"
                  placeholder={v.placeholder}
                  value={state.variableFields[v.key] ?? ""}
                  onChange={(e) =>
                    onPatch({
                      variableFields: {
                        ...state.variableFields,
                        [v.key]: e.target.value,
                      },
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Extra fields */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Extra fields (optional)</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onAddExtra}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add field
          </Button>
        </div>
        {state.extraFields.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Map additional form answers or hard-coded values (e.g. UTM tags) to
            the destination payload.
          </p>
        ) : (
          <div className="space-y-2">
            {state.extraFields.map((ef, i) => (
              <ExtraFieldRow
                key={i}
                field={ef}
                formFields={formFields}
                onChange={(p) => onUpdateExtra(i, p)}
                onRemove={() => onRemoveExtra(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── FieldSelect ──────────────────────────────────────────────────────────────

interface FieldSelectProps {
  label: string;
  value: string;
  formFields: Array<{ key: string; label?: string | null }>;
  onChange: (v: string) => void;
  placeholder: string;
}

function FieldSelect({
  label,
  value,
  formFields,
  onChange,
  placeholder,
}: FieldSelectProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {formFields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label ? `${f.label} (${f.key})` : f.key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── ExtraFieldRow ────────────────────────────────────────────────────────────

interface ExtraFieldRowProps {
  field: ExtraFieldDraft;
  formFields: Array<{ key: string; label?: string | null }>;
  onChange: (p: Partial<ExtraFieldDraft>) => void;
  onRemove: () => void;
}

function ExtraFieldRow({
  field,
  formFields,
  onChange,
  onRemove,
}: ExtraFieldRowProps) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-background p-2">
      <div className="grid flex-1 gap-2 sm:grid-cols-[140px_100px_1fr]">
        <Input
          className="h-8 text-xs font-mono"
          placeholder="dest_key"
          value={field.destKey}
          onChange={(e) => onChange({ destKey: e.target.value })}
        />
        <Select
          value={field.sourceType}
          onValueChange={(v) =>
            onChange({ sourceType: v as "form" | "static" })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="form">From form</SelectItem>
            <SelectItem value="static">Static value</SelectItem>
          </SelectContent>
        </Select>
        {field.sourceType === "form" ? (
          <Select
            value={field.sourceField || undefined}
            onValueChange={(v) => onChange({ sourceField: v })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Pick source" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel className="text-[11px]">Form fields</SelectLabel>
                {formFields.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label ? `${f.label} (${f.key})` : f.key}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel className="text-[11px]">FB metadata</SelectLabel>
                {FB_METADATA_FIELDS.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {FB_METADATA_LABELS[m.key]} ({m.key})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-8 text-xs"
            placeholder="Static value"
            value={field.staticValue ?? ""}
            onChange={(e) => onChange({ staticValue: e.target.value })}
          />
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label="Remove field"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ─── Small utility subcomponents ──────────────────────────────────────────────

function LoadingBar() {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Loading…
    </div>
  );
}

function EmptyHint({
  message,
  ctaLabel,
  href,
}: {
  message: string;
  ctaLabel?: string;
  href?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed bg-muted/10 p-3 text-xs">
      <div className="flex-1 text-muted-foreground">{message}</div>
      {ctaLabel && href && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
          onClick={() => window.open(href, "_blank")}
        >
          <Pencil className="h-3 w-3 mr-1" /> {ctaLabel}
        </Button>
      )}
    </div>
  );
}

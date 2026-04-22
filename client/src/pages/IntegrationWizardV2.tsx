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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Facebook,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Send,
  Sparkles,
  Tag,
  Trash2,
  Type,
  User,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { DestinationCreatorInline } from "@/components/destinations/DestinationCreatorInline";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One entry in the ordered destination list. */
interface DestinationEntry {
  id: number;
  name: string;
  templateType: string;
}

interface WizardState {
  // Trigger
  accountId: number | null;
  accountName: string;
  pageId: string;
  pageName: string;
  formId: string;
  formName: string;
  // Destinations — ordered list (Commit 6c). The first entry is the
  // "primary" destination: it drives field mapping + variable resolution
  // and is written to `integrations.targetWebsiteId` for legacy compat.
  // Additional entries fan-out via `integration_destinations`.
  destinations: DestinationEntry[];
  // Mapping (applies to the primary destination)
  nameField: string;
  phoneField: string;
  extraFields: ExtraFieldDraft[];
  variableFields: Record<string, string>;
  // Meta
  integrationName: string;
  /**
   * True once the user has manually edited the integration name. Until then
   * the auto-fill effect keeps it in sync with "page → destinations" so that
   * changing the destination list updates the preview automatically.
   */
  integrationNameTouched: boolean;
}

const INITIAL_STATE: WizardState = {
  accountId: null,
  accountName: "",
  pageId: "",
  pageName: "",
  formId: "",
  formName: "",
  destinations: [],
  nameField: "",
  phoneField: "",
  extraFields: [],
  variableFields: {},
  integrationName: "",
  integrationNameTouched: false,
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

// ─── Zapier-style step chrome ─────────────────────────────────────────────────

interface ZapperStepProps {
  /** Icon shown in the circle (step 1 = Facebook, step 2 = app icon or Zap). */
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind bg+text classes for the icon badge when not done. */
  iconColor: string;
  /** Small ALL-CAPS label above the app name: "TRIGGER" or "ACTION". */
  label: string;
  /** Prominent app name: "Facebook Lead Ads", "Telegram", etc. */
  appName: string;
  /** Step is visually highlighted (primary border on circle). */
  isActive: boolean;
  /** Step is fully filled — circle becomes solid primary, shows checkmark. */
  isDone: boolean;
  /** Step is not yet reachable — content is hidden and circle is dimmed. */
  isLocked?: boolean;
  /** Whether to render the content card (controlled by parent). */
  isOpen: boolean;
  /** Whether to draw the vertical connector below this step. */
  isLast?: boolean;
  /** One-line summary shown when isDone && !isOpen. */
  summary?: string;
  /** Clicking the header when isDone triggers this to re-open the step. */
  onHeaderClick?: () => void;
  children?: React.ReactNode;
}

function ZapperStep({
  icon: Icon,
  iconColor,
  label,
  appName,
  isActive,
  isDone,
  isLocked,
  isOpen,
  isLast,
  summary,
  onHeaderClick,
  children,
}: ZapperStepProps) {
  return (
    <div className="flex gap-4">
      {/* ── Left rail: circle + connector line ── */}
      <div className="flex flex-col items-center shrink-0 w-10">
        <button
          type="button"
          disabled={isLocked}
          onClick={onHeaderClick}
          className={cn(
            "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 bg-background transition-colors",
            isDone && !isOpen
              ? "border-primary bg-primary"
              : isActive
                ? "border-primary"
                : isLocked
                  ? "border-muted-foreground/20"
                  : "border-muted-foreground/30",
          )}
          aria-label={`Go to ${label}`}
        >
          {isDone && !isOpen ? (
            <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
          ) : (
            <Icon
              className={cn(
                "h-4 w-4 transition-colors",
                isLocked
                  ? "text-muted-foreground/25"
                  : isActive
                    ? iconColor
                    : "text-muted-foreground/50",
              )}
            />
          )}
        </button>
        {/* Vertical connector */}
        {!isLast && (
          <div
            className={cn(
              "w-px flex-1 mt-1",
              isDone ? "bg-primary/30" : "bg-border",
            )}
            style={{ minHeight: "32px" }}
          />
        )}
      </div>

      {/* ── Right content ── */}
      <div className={cn("flex-1 pb-6", isLast && "pb-2")}>
        {/* Step header (clickable when done) */}
        <div className="flex items-start justify-between min-h-[40px] mb-3">
          <button
            type="button"
            disabled={isLocked || isOpen}
            onClick={onHeaderClick}
            className={cn(
              "text-left",
              !isLocked && !isOpen && "hover:opacity-80",
            )}
          >
            <div
              className={cn(
                "text-[10px] uppercase tracking-widest font-semibold leading-none mb-1",
                isLocked ? "text-muted-foreground/40" : "text-muted-foreground",
              )}
            >
              {label}
            </div>
            <div
              className={cn(
                "text-sm font-bold leading-none",
                isLocked && "text-muted-foreground/40",
              )}
            >
              {appName}
            </div>
          </button>
          {isDone && !isOpen && (
            <button
              type="button"
              onClick={onHeaderClick}
              className="ml-3 text-[11px] text-primary hover:underline shrink-0 mt-0.5"
            >
              Edit
            </button>
          )}
        </div>

        {/* Done summary pill (when collapsed) */}
        {isDone && !isOpen && summary && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/8 border border-primary/20 px-3 py-1 text-xs text-primary font-medium mb-2">
            <CheckCircle2 className="h-3 w-3" />
            {summary}
          </div>
        )}

        {/* Content card (when open) */}
        {isOpen && !isLocked && (
          <div className="rounded-xl border bg-card shadow-sm p-5">
            {children}
          </div>
        )}

        {/* Locked placeholder */}
        {isLocked && (
          <div className="rounded-xl border border-dashed bg-muted/5 px-4 py-3 text-xs text-muted-foreground/50">
            Complete the trigger step first.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function IntegrationWizardV2() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [state, setState] = useState<WizardState>(INITIAL_STATE);

  // Zapier-style: which step is currently "focused" (highlighted header + open).
  // Step 1 = Trigger, Step 2 = Action.
  const [activeStep, setActiveStep] = useState<1 | 2>(1);

  // Inline destination creator state.
  // undefined  → showing the normal destination picker / mapping / publish view
  // null       → showing inline creator in "pick app" mode (full app list)
  // string     → showing inline creator starting at configure for that app key
  const [inlineCreatorAppKey, setInlineCreatorAppKey] = useState<
    string | null | undefined
  >(undefined);

  const handleOpenCreatorForApp = (appKey?: string) => {
    // undefined means "open the full app picker" (null), a key skips to config.
    setInlineCreatorAppKey(appKey ?? null);
  };

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

  // Derived: primary destination (first in the list) drives field mapping.
  const primaryDest: DestinationEntry | null = state.destinations[0] ?? null;
  const primaryDestId = primaryDest?.id ?? null;
  const primaryDestName = primaryDest?.name ?? "";
  const primaryDestType = primaryDest?.templateType ?? "";

  const { data: customVarNames = [] } =
    trpc.targetWebsites.getCustomVariables.useQuery(
      { id: primaryDestId ?? 0 },
      {
        enabled:
          isAllowed &&
          !!primaryDestId &&
          primaryDestType === "custom",
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

  // ─── Auto-fill: integration name once page + destinations are chosen ────────
  // Tracks the "auto" vs "user-edited" state via `integrationNameTouched`. As
  // long as the user hasn't typed into the name field, we keep the suggestion
  // in sync with the page name and destination list so adding/removing a
  // destination updates the preview automatically.
  useEffect(() => {
    if (state.integrationNameTouched) return;
    if (!state.pageName || state.destinations.length === 0) return;
    const destLabel =
      state.destinations.length === 1
        ? state.destinations[0]!.name
        : `${state.destinations[0]!.name} +${state.destinations.length - 1} more`;
    const suggested = `${state.pageName} → ${destLabel}`;
    if (state.integrationName !== suggested) {
      setState((s) => ({ ...s, integrationName: suggested }));
    }
  }, [
    state.pageName,
    state.destinations,
    state.integrationName,
    state.integrationNameTouched,
  ]);

  // ─── Auto-fill: seed variableFields with empty placeholders for custom ────
  // templates so the mapping card has something to render. Existing values
  // are preserved — we only fill in keys that aren't there yet.
  useEffect(() => {
    if (primaryDestType !== "custom") return;
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
  }, [customVarNames, primaryDestType]);

  // ─── Derived: variables required by the PRIMARY destination template ────────
  const requiredVarKeys = useMemo(() => {
    if (primaryDestType === "telegram") return [] as string[];
    if (primaryDestType === "custom") return customVarNames;
    const defs = TEMPLATE_VARIABLE_FIELDS[primaryDestType] ?? [];
    return defs.filter((d) => d.required).map((d) => d.key);
  }, [primaryDestType, customVarNames]);

  // ─── Validation ────────────────────────────────────────────────────────────
  const triggerFilled =
    !!state.accountId && !!state.pageId && !!state.formId;
  const destinationFilled = state.destinations.length > 0;
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
    // Auto-advance to step 2 (action) for forward momentum.
    setActiveStep(2);
  };

  /** Add a destination to the list if not already present. */
  const addDestination = (id: number, name: string, templateType: string) => {
    setState((s) => {
      if (s.destinations.some((d) => d.id === id)) return s; // already added
      const next = [...s.destinations, { id, name, templateType }];
      // If this is the first destination, reset variable fields (new template).
      const variableFields = s.destinations.length === 0 ? {} : s.variableFields;
      return { ...s, destinations: next, variableFields };
    });
    // In the Zapier-style layout, mapping is shown inline in step 2 — no card
    // jump needed. We stay in step 2 and the mapping section appears below.
  };

  /** Remove a destination from the list by id. */
  const removeDestination = (id: number) => {
    setState((s) => {
      const next = s.destinations.filter((d) => d.id !== id);
      // If we removed the primary destination, reset variable fields.
      const removedPrimary = s.destinations[0]?.id === id;
      return {
        ...s,
        destinations: next,
        variableFields: removedPrimary ? {} : s.variableFields,
      };
    });
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
    // The config embeds the PRIMARY destination for legacy dispatch compat.
    // Additional destinations are tracked via integration_destinations, passed
    // separately as destinationIds so the backend calls setIntegrationDestinations.
    const config = {
      facebookAccountId: state.accountId,
      pageId: state.pageId,
      pageName: state.pageName,
      formId: state.formId,
      formName: state.formName,
      nameField: state.nameField,
      phoneField: state.phoneField,
      extraFields: serializeExtraFields(state.extraFields),
      // Legacy compat: first destination id/name/type in config.
      targetWebsiteId: primaryDestId,
      targetWebsiteName: primaryDestName,
      targetTemplateType: primaryDestType,
      variableFields: state.variableFields,
    };
    const destinationIds = state.destinations.map((d) => d.id);
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
        destinationIds,
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

  // ─── Derived: step 2 app icon + color ─────────────────────────────────────
  // Show the primary destination's category icon in the step 2 circle; fall
  // back to Zap when nothing is selected yet.
  const step2Icon = destinationFilled
    ? iconForCategory(
        targetWebsites?.find((t) => t.id === primaryDestId)?.category ?? "",
      )
    : Zap;
  const step2IconColor = destinationFilled
    ? (
        CATEGORY_META[
          (targetWebsites?.find((t) => t.id === primaryDestId)
            ?.category ?? "") as DestinationCategory
        ]?.colorClass ?? "text-muted-foreground"
      )
        .split(" ")
        .find((c) => c.startsWith("text-")) ?? "text-primary"
    : "text-muted-foreground";

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto py-6 px-4 pb-16">
        {/* ── Page header ── */}
        <div className="flex items-center gap-2 mb-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/integrations")}
            className="h-8 -ml-2 text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Integrations
          </Button>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="text-sm text-muted-foreground">New integration</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium">
            <Sparkles className="h-2.5 w-2.5" />
            Beta
          </span>
        </div>

        <h1 className="text-xl font-bold tracking-tight mb-8">
          New Zap
        </h1>

        {/* ── Zapier-style vertical flow ── */}
        <div>
          {/* ─ Step 1: Trigger ─ */}
          <ZapperStep
            icon={Facebook}
            iconColor="text-blue-600"
            label="Trigger"
            appName="Facebook Lead Ads"
            isActive={activeStep === 1}
            isDone={triggerFilled}
            isOpen={activeStep === 1}
            isLast={false}
            summary={
              triggerFilled
                ? `${state.pageName} / ${state.formName}`
                : undefined
            }
            onHeaderClick={() => setActiveStep(1)}
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
            {/* Continue button — advances to step 2 */}
            {triggerFilled && (
              <div className="flex justify-end pt-4 mt-1 border-t">
                <Button
                  size="sm"
                  onClick={() => setActiveStep(2)}
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </ZapperStep>

          {/* ─ Step 2: Action ─ */}
          <ZapperStep
            icon={step2Icon}
            iconColor={step2IconColor}
            label="Action"
            appName={
              destinationFilled
                ? state.destinations.length === 1
                  ? primaryDestName
                  : `${primaryDestName} +${state.destinations.length - 1} more`
                : "Choose destination"
            }
            isActive={activeStep === 2}
            isDone={canSave}
            isLocked={!triggerFilled}
            isOpen={triggerFilled}
            isLast={true}
            summary={canSave ? state.integrationName : undefined}
            onHeaderClick={() => triggerFilled && setActiveStep(2)}
          >
            {inlineCreatorAppKey !== undefined ? (
              /* ── Inline destination creator (Zapier-style, no drawer) ── */
              <DestinationCreatorInline
                initialAppKey={inlineCreatorAppKey ?? undefined}
                onCreated={({ id, name, templateType }) => {
                  addDestination(id, name, templateType);
                  setInlineCreatorAppKey(undefined);
                }}
                onCancel={() => setInlineCreatorAppKey(undefined)}
              />
            ) : (
              /* ── Normal picker → mapping → publish flow ── */
              <>
                {/* Destination picker */}
                <div>
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Destination
                  </div>
                  <DestinationEditor
                    destinations={targetWebsites ?? []}
                    loading={loadingTargets}
                    selectedIds={state.destinations.map((d) => d.id)}
                    onToggle={(id, name, templateType) => {
                      if (state.destinations.some((d) => d.id === id)) {
                        removeDestination(id);
                      } else {
                        addDestination(id, name, templateType);
                      }
                    }}
                    onOpenCreatorForApp={handleOpenCreatorForApp}
                  />
                </div>

                {/* Field mapping (shown once a destination is picked) */}
                {destinationFilled && (
                  <div className="border-t mt-5 pt-5 space-y-4">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Map fields
                      <span className="ml-1.5 normal-case font-normal">
                        ({primaryDestName})
                      </span>
                    </div>
                    <MappingEditor
                      formFields={formFields ?? []}
                      loadingFields={loadingFields}
                      state={state}
                      primaryDestName={primaryDestName}
                      primaryDestType={primaryDestType}
                      onPatch={patch}
                      onAddExtra={addExtra}
                      onUpdateExtra={updateExtra}
                      onRemoveExtra={removeExtra}
                    />
                  </div>
                )}

                {/* Integration name + Publish (shown once destination is picked) */}
                {destinationFilled && (
                  <div className="border-t mt-5 pt-5 space-y-4">
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="integration-name"
                        className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                      >
                        Integration name
                      </Label>
                      <Input
                        id="integration-name"
                        value={state.integrationName}
                        onChange={(e) =>
                          patch({
                            integrationName: e.target.value,
                            integrationNameTouched: true,
                          })
                        }
                        placeholder={
                          state.pageName && primaryDestName
                            ? `${state.pageName} → ${primaryDestName}`
                            : "My integration"
                        }
                      />
                      {state.integrationNameTouched && (
                        <button
                          type="button"
                          onClick={() =>
                            patch({
                              integrationName: "",
                              integrationNameTouched: false,
                            })
                          }
                          className="text-[11px] text-muted-foreground hover:text-primary"
                        >
                          Reset to auto-generated name
                        </button>
                      )}
                    </div>

                    {/* Publish row */}
                    <div className="flex items-center justify-between pt-1">
                      <p className="text-xs text-muted-foreground">
                        {canSave
                          ? "Ready to publish — activates immediately."
                          : "Fill in Name and Phone fields to publish."}
                      </p>
                      <div className="flex items-center gap-2 ml-4 shrink-0">
                        <Button
                          variant="ghost"
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
                          Publish
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </ZapperStep>
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
  /** IDs currently in the wizard's selected list. */
  selectedIds: number[];
  /** Toggle a destination: add if not selected, remove if selected. */
  onToggle: (id: number, name: string, templateType: string) => void;
  /**
   * Open the creator drawer. Pass an appKey to skip the app-picker step and
   * go directly to the configure form for that app (Variant C).
   * Omit (or pass undefined) to show the full app picker.
   */
  onOpenCreatorForApp: (appKey?: string) => void;
}

/** Quick-connect cards shown at the top of the destination picker. */
const DEST_APP_SHORTCUTS = [
  {
    key: "telegram",
    name: "Telegram",
    desc: "Send as a message",
    Icon: Send,
    bg: "bg-sky-100 dark:bg-sky-900/40",
    text: "text-sky-600 dark:text-sky-400",
    ring: "hover:border-sky-300 dark:hover:border-sky-600",
  },
  {
    key: "google-sheets",
    name: "Google Sheets",
    desc: "Append a row",
    Icon: FileText,
    bg: "bg-emerald-100 dark:bg-emerald-900/40",
    text: "text-emerald-600 dark:text-emerald-400",
    ring: "hover:border-emerald-300 dark:hover:border-emerald-600",
  },
  {
    key: "plain-url",
    name: "HTTP Webhook",
    desc: "POST to any URL",
    Icon: Globe,
    bg: "bg-violet-100 dark:bg-violet-900/40",
    text: "text-violet-600 dark:text-violet-400",
    ring: "hover:border-violet-300 dark:hover:border-violet-600",
  },
] as const;

function DestinationEditor({
  destinations,
  loading,
  selectedIds,
  onToggle,
  onOpenCreatorForApp,
}: DestinationEditorProps) {
  // showPicker: true  = full picker (app cards + existing list)
  //             false = chip view (selected destinations summary)
  // Starts as true when nothing selected, false once something is selected.
  const [showPicker, setShowPicker] = useState(selectedIds.length === 0);
  const [search, setSearch] = useState("");

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Auto-show picker when all destinations are removed.
  const prevLen = useRef(selectedIds.length);
  useEffect(() => {
    if (selectedIds.length === 0) setShowPicker(true);
    prevLen.current = selectedIds.length;
  }, [selectedIds.length]);

  // Wrap toggle: auto-close picker when a destination is ADDED.
  const handleToggle = (id: number, name: string, templateType: string) => {
    const isAdding = !selectedSet.has(id);
    onToggle(id, name, templateType);
    if (isAdding) setShowPicker(false);
  };

  const filteredExisting = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter((d) => d.name.toLowerCase().includes(q));
  }, [destinations, search]);

  if (loading) return <LoadingBar />;

  // ── Chip view: destination is selected, picker is hidden ───────────────
  if (!showPicker && selectedIds.length > 0) {
    return (
      <div className="space-y-2">
        {selectedIds.map((id, idx) => {
          const d = destinations.find((x) => x.id === id);
          if (!d) return null;
          const Icon = iconForCategory(d.category);
          const color = colorForCategory(d.category);
          return (
            <div
              key={id}
              className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-3"
            >
              <div
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                  color,
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{d.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {idx === 0 ? "Primary · drives mapping" : `Destination ${idx + 1}`}
                  {" · "}
                  {d.templateName || d.templateType}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onToggle(id, d.name, d.templateType)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                aria-label={`Remove ${d.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}

        {/* Actions row */}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add another destination
          </button>
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="text-xs text-muted-foreground hover:text-primary transition-colors underline underline-offset-2"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  // ── Picker view: app shortcut cards + existing list ─────────────────────
  return (
    <div className="space-y-4">
      {/* Back link when some destinations already chosen */}
      {selectedIds.length > 0 && (
        <button
          type="button"
          onClick={() => setShowPicker(false)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to selected ({selectedIds.length})
        </button>
      )}

      {/* App shortcut cards */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">
          Connect a new destination
        </div>
        <div className="grid grid-cols-3 gap-2">
          {DEST_APP_SHORTCUTS.map((app) => (
            <button
              key={app.key}
              type="button"
              onClick={() => onOpenCreatorForApp(app.key)}
              className={cn(
                "group flex flex-col items-center gap-2.5 rounded-xl border bg-background p-3.5 text-center transition-all hover:shadow-sm",
                app.ring,
              )}
            >
              <div
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-105",
                  app.bg,
                )}
              >
                <app.Icon className={cn("h-5 w-5", app.text)} />
              </div>
              <div>
                <div className="text-xs font-semibold leading-tight">
                  {app.name}
                </div>
                <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                  {app.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Pick from existing */}
      {destinations.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-foreground px-1">
              or pick from existing
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter…"
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 pl-7 text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                aria-label="Clear"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {filteredExisting.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              No destinations match &ldquo;{search}&rdquo;.
            </p>
          ) : (
            <div className="max-h-52 overflow-y-auto rounded-lg border bg-muted/5 p-1 space-y-0.5">
              {filteredExisting.map((d) => {
                const isSelected = selectedSet.has(d.id);
                const Icon = iconForCategory(d.category);
                const color = colorForCategory(d.category);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => handleToggle(d.id, d.name, d.templateType)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors",
                      isSelected ? "bg-primary/8 font-medium" : "hover:bg-muted/60",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                        color,
                      )}
                    >
                      <Icon className="h-3 w-3" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate leading-tight">{d.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {d.templateName || d.templateType}
                      </span>
                    </div>
                    {isSelected ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MappingEditor ────────────────────────────────────────────────────────────

interface MappingEditorProps {
  formFields: Array<{ key: string; label?: string | null }>;
  loadingFields: boolean;
  state: WizardState;
  /** Name of the primary destination (drives variable labels). */
  primaryDestName: string;
  /** Template type of the primary destination. */
  primaryDestType: string;
  onPatch: (p: Partial<WizardState>) => void;
  onAddExtra: () => void;
  onUpdateExtra: (index: number, p: Partial<ExtraFieldDraft>) => void;
  onRemoveExtra: (index: number) => void;
}

function MappingEditor({
  formFields,
  loadingFields,
  state,
  primaryDestName,
  primaryDestType,
  onPatch,
  onAddExtra,
  onUpdateExtra,
  onRemoveExtra,
}: MappingEditorProps) {
  const templateDefs = TEMPLATE_VARIABLE_FIELDS[primaryDestType] ?? [];
  const isCustom = primaryDestType === "custom";
  const isTelegram = primaryDestType === "telegram";

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
              ({primaryDestName})
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

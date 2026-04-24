/**
 * IntegrationWizardV2 — Make.com-style stacked-card wizard for creating a
 * LEAD_ROUTING integration.
 *
 * Mounted at /integrations/new-v2 and /integrations/edit-v2/:id.
 * Old URLs `/integrations/new-routing` and `/integrations/edit-routing/:id`
 * redirect here (see App.tsx).
 *
 * The wizard persists the integration.config shape expected by lead delivery:
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
  SelectItem,
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
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Search,
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
import { useLocation, useParams } from "wouter";
import {
  FB_METADATA_FIELDS,
  FB_METADATA_LABELS,
  NAME_PATTERNS,
  PHONE_PATTERNS,
  autoMatchField,
  serializeFieldMappings,
  type FieldMapping,
} from "./lead-routing/shared";
import { DestinationCreatorInline } from "@/components/destinations/DestinationCreatorInline";
import {
  GroupedFieldPicker,
  type GroupedFieldPickerGroup,
} from "@/components/common/GroupedFieldPicker";
import { resolveAppIcon, appIconBgClass, appIconRingClass } from "@/components/destinations/appIcons";
import { isSupportedAppKey } from "@/components/destinations/createPayload";
import { WizardActionPickerModal } from "@/components/wizard/WizardActionPickerModal";
import type { AppManifestService } from "./lead-routing/shared";

// ─── resolveDestManifest ───────────────────────────────────────────────────────
// Resolves the AppManifestService for a destination record.
//
// This is the single "spine" merging the two service-definition worlds:
//   • admin-managed `destination_templates` (DB rows, infinite scale)
//   • code-registered server manifests (Telegram, Sheets, HTTP Webhook, …)
//
// Priority (first match wins):
//   ⓪. destType === "custom"    → CUSTOM_MANIFEST (row-builder UI)
//   ①. DB autoMappedFields set   → fully dynamic manifest from DB
//   ②. templateId set, AMF empty → UZ-CPA convention (name+phone FROM_LEAD)
//   ③. Server manifest app.key   → default name+phone leadFields
//
// The client-side APP_MANIFEST registry (hardcoded sotuvchi/100k/telegram
// entries) was retired in favour of the two sources above.
type DestRecordLike = {
  templateId?: number | null;
  templateName?: string | null;
  autoMappedFields?: unknown;
  /** List of keys admin declared as per-integration variables (offer_id, stream, …). */
  variableFields?: unknown;
  /** List of keys backed by saved credentials (api_key, bot_token, …). */
  userVisibleFields?: unknown;
  /** Already-masked view from targetWebsites.list — holds admin defaults + masked secrets. */
  templateConfig?: unknown;
};

type ServerAppStub = { key: string; name: string; description: string | null };

// Turn a machine key into something humans tolerate reading: "offer_id" → "Offer id".
// We keep it minimal (Title Case on the first word, spaces instead of
// underscores) so translated labels from admin-managed templates win whenever
// they're provided.
function humanizeKey(key: string): string {
  if (!key) return "";
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const DEFAULT_LEAD_FIELDS: import("./lead-routing/shared").AppManifestLeadField[] = [
  { key: "name",  label: "Ism (to'liq)",   required: true, mode: "auto", autoDetect: "name"  },
  { key: "phone", label: "Telefon raqami",  required: true, mode: "auto", autoDetect: "phone" },
];

// Custom Webhook is the only "app" that genuinely has no lead schema — the
// user builds the mapping row-by-row via FieldMappingsEditor. Kept inline
// (rather than in shared.ts) because it is rendering glue, not a service def.
const CUSTOM_MANIFEST: AppManifestService = {
  id: "custom",
  label: "Custom Webhook",
  description: "POST to any URL",
  leadFields: [],
  connectionKeys: [],
};

/**
 * Resolve the secret preview shown in mode="secret" chips.
 *
 * Admin-managed templates currently stash masked previews inside
 * `templateConfig.apiKeyMasked` / `templateConfig.botTokenMasked` (via
 * maskConfig on the server). Other secret keys fall back to a generic
 * "••••" indicator so the user still sees that a credential is on file.
 */
function previewForSecretKey(
  key: string,
  templateConfig: Record<string, unknown>,
): string {
  if (key.includes("api_key") || key === "apiKey") {
    const masked = templateConfig.apiKeyMasked;
    if (typeof masked === "string" && masked) return masked;
  }
  if (key.includes("bot_token") || key === "botToken") {
    const masked = templateConfig.botTokenMasked;
    if (typeof masked === "string" && masked) return masked;
  }
  const direct = templateConfig[`${key}Masked`];
  if (typeof direct === "string" && direct) return direct;
  return "••••";
}

function resolveDestManifest(
  destRecord: DestRecordLike | null | undefined,
  destType: string,
  destName: string,
  serverApps: ServerAppStub[] = [],
): AppManifestService | null {
  if (!destType) return null;

  // ⓪ Real (bare) custom webhook — no schema, wizard uses FieldMappingsEditor.
  //
  // Caveat: admin-managed template destinations (sotuvchi, 100k, inbaza, …)
  // are ALSO persisted with `templateType: "custom"` for backwards-compat
  // with the original UZ-CPA schema; what distinguishes them is a
  // non-null `templateId` pointing at the destination_templates row.
  // Skipping path ⓪ in that case lets path ① build the dynamic
  // auto/static/secret mapping grid instead of short-circuiting to the
  // generic custom-webhook row builder.
  const hasTemplate = (destRecord?.templateId ?? null) !== null;
  if (destType === "custom" && !hasTemplate) return CUSTOM_MANIFEST;

  const dbAutoFields = (
    Array.isArray(destRecord?.autoMappedFields) ? destRecord!.autoMappedFields : []
  ) as Array<{ key: string; label: string }>;

  // ① DB has explicit autoMappedFields — fully dynamic manifest.
  // Covers admin destination_templates (sotuvchi, 100k, inbaza, mycpa, …).
  //
  // We walk THREE ordered sources to build the Make.com-style mapping grid:
  //   A) autoMappedFields  → mode="auto"   (name, phone — FB form dropdown)
  //   B) variableFields    → mode="static" (offer_id, stream — per-integration text)
  //   C) userVisibleFields → mode="secret" (api_key — from the saved connection)
  //
  // A key appearing in more than one list wins in this order (auto > static >
  // secret) so admins can't accidentally make a FROM_LEAD field also a secret.
  if (dbAutoFields.length > 0) {
    const variableKeys = (
      Array.isArray(destRecord?.variableFields) ? destRecord!.variableFields : []
    ) as string[];
    const secretKeys = (
      Array.isArray(destRecord?.userVisibleFields) ? destRecord!.userVisibleFields : []
    ) as string[];
    const tplCfg = (destRecord?.templateConfig ?? {}) as Record<string, unknown>;

    const leadFields: import("./lead-routing/shared").AppManifestLeadField[] = [];
    const seen = new Set<string>();

    for (const f of dbAutoFields) {
      if (!f.key || seen.has(f.key)) continue;
      seen.add(f.key);
      leadFields.push({
        key: f.key,
        label: f.label || humanizeKey(f.key),
        required: true,
        mode: "auto",
        autoDetect:
          f.key === "name" || /name/i.test(f.key)
            ? "name"
            : f.key === "phone" || /phone/i.test(f.key)
              ? "phone"
              : undefined,
      });
    }

    for (const key of variableKeys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const preset = tplCfg[key];
      leadFields.push({
        key,
        label: humanizeKey(key),
        required: true,
        mode: "static",
        staticDefault: typeof preset === "string" ? preset : "",
      });
    }

    for (const key of secretKeys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leadFields.push({
        key,
        label: humanizeKey(key),
        required: false, // already captured at destination creation; UI is read-only
        mode: "secret",
        secretLabel: previewForSecretKey(key, tplCfg),
      });
    }

    return {
      id: destType,
      label: destRecord?.templateName ?? destName,
      description: "",
      leadFields,
      // connectionKeys is now redundant for this path: secret + variable keys
      // are inline rows in leadFields. Left empty so the "Connection config"
      // block in AppManifestMapper hides itself.
      connectionKeys: [],
    };
  }

  // ② Admin-created template (templateId set) but autoMappedFields empty —
  // fall back to the universal UZ-CPA convention (name + phone FROM_LEAD).
  // Still expose variableFields as legacy connection keys for the read-only
  // Connection box so existing destinations keep rendering identically until
  // their admin adds autoMappedFields.
  const isAdminTemplate = (destRecord?.templateId ?? null) !== null;
  if (isAdminTemplate) {
    return {
      id: destType,
      label: destRecord?.templateName ?? destName,
      description: "",
      leadFields: DEFAULT_LEAD_FIELDS,
      connectionKeys: (
        Array.isArray(destRecord?.variableFields) ? destRecord!.variableFields : []
      ) as string[],
    };
  }

  // ③ Server manifest fallback — telegram, google-sheets, http-webhook,
  // and every future code-defined app. Default lead schema (name + phone)
  // because the FROM_LEAD stage is universal for inbound lead triggers.
  const serverApp = serverApps.find((a) => a.key === destType);
  if (serverApp) {
    return {
      id: serverApp.key,
      label: serverApp.name,
      description: serverApp.description ?? "",
      leadFields: DEFAULT_LEAD_FIELDS,
      connectionKeys: [],
    };
  }

  return null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One entry in the ordered destination list.
 *
 * `leadFields` — per-destination FROM_LEAD mapping (via resolveDestManifest).
 *   key   = manifest field key ("name", "phone", or custom for custom type)
 *   value = FB form field key that feeds this payload key ("full_name", etc.)
 * For `custom` template type, `leadFields` is empty and `customMappings` is
 * used instead (the FieldMappingsEditor rows).
 */
interface DestinationEntry {
  id: number;
  name: string;
  templateType: string;
  /** Manifest-driven FROM_LEAD mappings: { name: "full_name", phone: "phone_number" } */
  leadFields: Record<string, string>;
  /**
   * Per-key static overrides for manifest fields with `mode: "static"`.
   * Seeded from the destination's `templateConfig[key]` admin default and
   * persisted to `integration.config.variableFields` on save so
   * `sendLeadViaTemplate` picks them up via `{{key}}` substitution in
   * bodyFields. Secrets (mode="secret") NEVER live here — they come from
   * the destination's stored credential and are read-only in the wizard.
   */
  staticValues: Record<string, string>;
  /** Custom/extra mappings for destinations without a fixed manifest (type="custom"). */
  customMappings: FieldMapping[];
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
  const params = useParams<{ id?: string }>();
  const editId = params?.id ? parseInt(params.id, 10) : null;
  const isEditMode = !!editId && !isNaN(editId);

  const utils = trpc.useUtils();
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  // Prevents re-initializing state on every render in edit mode.
  const [stateInitialized, setStateInitialized] = useState(!isEditMode);

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

  // Zapier-style app picker — opened by the "+ Add action" button below the
  // collapsed trigger and by "Add another destination" inside the chip view.
  const [actionPickerOpen, setActionPickerOpen] = useState(false);

  // ─── Edit mode: load existing integration ─────────────────────────────────
  const { data: integrationsList } = trpc.integrations.list.useQuery(undefined, {
    enabled: isEditMode,
  });
  const editIntegration = isEditMode
    ? integrationsList?.find((i) => i.id === editId)
    : undefined;

  // ─── tRPC data queries ─────────────────────────────────────────────────────
  const { data: accounts, isLoading: loadingAccounts } =
    trpc.facebookAccounts.list.useQuery(undefined);

  const { data: pages, isLoading: loadingPages } =
    trpc.facebookAccounts.listPages.useQuery(
      { accountId: state.accountId ?? 0 },
      { enabled: !!state.accountId },
    );

  const { data: forms, isLoading: loadingForms } =
    trpc.facebookAccounts.listForms.useQuery(
      { accountId: state.accountId ?? 0, pageId: state.pageId },
      { enabled: !!state.accountId && !!state.pageId },
    );

  const { data: formFields, isLoading: loadingFields } =
    trpc.facebookAccounts.listFormFields.useQuery(
      {
        accountId: state.accountId ?? 0,
        pageId: state.pageId,
        formId: state.formId,
      },
      { enabled: !!state.accountId && !!state.pageId && !!state.formId },
    );

  const { data: targetWebsites, isLoading: loadingTargets } =
    trpc.targetWebsites.list.useQuery(undefined);

  const { data: appManifests = [] } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  // Derived: primary destination (first in the list) drives field mapping.
  const primaryDest: DestinationEntry | null = state.destinations[0] ?? null;
  const primaryDestId = primaryDest?.id ?? null;
  const primaryDestName = primaryDest?.name ?? "";
  const primaryDestType = primaryDest?.templateType ?? "";

  const { data: customVarNames = [] } =
    trpc.targetWebsites.getCustomVariables.useQuery(
      { id: primaryDestId ?? 0 },
      {
        enabled: !!primaryDestId && primaryDestType === "custom",
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
  const updateMutation = trpc.integrations.update.useMutation({
    onSuccess: () => {
      toast.success("Integration updated!");
      utils.integrations.list.invalidate();
      navigate("/integrations");
    },
    onError: (err) => toast.error(err.message),
  });

  // ─── Edit mode: populate wizard state from saved integration ──────────────
  useEffect(() => {
    if (!isEditMode || stateInitialized) return;
    if (!editIntegration || !targetWebsites) return;

    const cfg = editIntegration.config as Record<string, unknown>;
    const savedDestIds = (editIntegration as unknown as { destinationIds?: number[] }).destinationIds;
    const destIds: number[] =
      savedDestIds && savedDestIds.length > 0
        ? savedDestIds
        : cfg.targetWebsiteId
          ? [Number(cfg.targetWebsiteId)]
          : [];

    const primaryTw = targetWebsites.find((t) => t.id === destIds[0]);
    const primaryType = primaryTw?.templateType ?? (cfg.targetTemplateType as string) ?? "custom";
    const hasTemplate = (primaryTw?.templateId ?? null) !== null;
    const isCustomDest = primaryType === "custom" && !hasTemplate;

    const savedFieldMappings = (cfg.fieldMappings as FieldMapping[] | undefined) ?? [];
    const leadFields: Record<string, string> = {};
    const primaryCustomMappings: FieldMapping[] = [];

    if (isCustomDest) {
      for (const fm of savedFieldMappings) {
        primaryCustomMappings.push({
          from: fm.from ?? null,
          to: fm.to,
          staticValue: fm.staticValue ?? "",
        });
      }
    } else {
      for (const fm of savedFieldMappings) {
        if (fm.from) leadFields[fm.to] = fm.from;
      }
    }

    const savedStaticValues = (cfg.variableFields as Record<string, string>) ?? {};

    const destinations: DestinationEntry[] = destIds.map((id, idx) => {
      const tw = targetWebsites.find((t) => t.id === id);
      return {
        id,
        name: tw?.name ?? (idx === 0 ? (cfg.targetWebsiteName as string) ?? "" : ""),
        templateType: tw?.templateType ?? (idx === 0 ? primaryType : "custom"),
        leadFields: idx === 0 ? leadFields : {},
        staticValues: idx === 0 ? savedStaticValues : {},
        customMappings: idx === 0 ? primaryCustomMappings : [],
      };
    });

    setState({
      accountId: cfg.facebookAccountId ? Number(cfg.facebookAccountId) : null,
      accountName: "",
      pageId: (cfg.pageId as string) ?? "",
      pageName: (cfg.pageName as string) ?? "",
      formId: (cfg.formId as string) ?? "",
      formName: (cfg.formName as string) ?? "",
      destinations,
      integrationName: editIntegration.name,
      integrationNameTouched: true,
    });
    setActiveStep(2);
    setStateInitialized(true);
  }, [isEditMode, editIntegration, targetWebsites, stateInitialized]);

  // ─── Auto-populate per-destination leadFields when form fields load ─────────
  // Runs after the FB form fields arrive (or the destination list updates with
  // fresh template metadata) and backfills two things:
  //   1. FROM_LEAD matches for mode="auto" fields (name / phone heuristics)
  //   2. Admin defaults for mode="static" fields (offer_id, stream, …) so
  //      when a user picks an existing destination they immediately see what
  //      will be sent instead of an empty box.
  // Existing user edits are never overwritten — we only fill EMPTY keys.
  useEffect(() => {
    if (!formFields?.length && !targetWebsites?.length) return;
    setState((s) => {
      const updated = s.destinations.map((d) => {
        const destRecord = targetWebsites?.find((t) => t.id === d.id);
        const manifest = resolveDestManifest(destRecord, d.templateType, d.name, appManifests);
        if (!manifest?.leadFields.length) return d;

        let changed = false;
        const leadFields = { ...d.leadFields };
        const staticValues = { ...d.staticValues };
        for (const lf of manifest.leadFields) {
          if (lf.mode === "auto") {
            if (leadFields[lf.key]) continue;
            if (!formFields?.length) continue;
            if (lf.autoDetect === "name") {
              const m = autoMatchField(formFields, NAME_PATTERNS);
              if (m) { leadFields[lf.key] = m; changed = true; }
            } else if (lf.autoDetect === "phone") {
              const m = autoMatchField(formFields, PHONE_PATTERNS);
              if (m) { leadFields[lf.key] = m; changed = true; }
            }
          } else if (lf.mode === "static") {
            if (staticValues[lf.key] !== undefined) continue;
            staticValues[lf.key] = lf.staticDefault ?? "";
            changed = true;
          }
        }
        return changed ? { ...d, leadFields, staticValues } : d;
      });
      return updated.some((d, i) => d !== s.destinations[i])
        ? { ...s, destinations: updated }
        : s;
    });
  }, [formFields, targetWebsites]);

  // ─── Trigger variable catalogue (for the Make.com-style Map toggle) ────────
  //
  // Build a "Field data" VariableGroup from the currently selected Facebook
  // lead form's questions, so every `mappable` field inside
  // DestinationCreatorInline gets a picker that lists the exact set of
  // tokens the server's extraFields will populate at delivery time.
  //
  // We intentionally exclude the two CORE questions (`full_name`,
  // `phone_number`) because those are NOT forwarded as extraFields server
  // side — they already live in the adapter's top-level metadata group as
  // `{{name}}` / `{{phone}}` (or `{{full_name}}` / `{{phone_number}}` for
  // Telegram). Surfacing them here would let users pick a token that
  // silently renders blank.
  const triggerVariableGroups = useMemo(() => {
    if (!formFields?.length) return undefined;
    const vars = formFields
      .filter((f) => {
        const k = f.key.toLowerCase();
        return k !== "full_name" && k !== "phone_number";
      })
      .map((f) => ({ key: f.key, label: f.label || f.key }));
    if (vars.length === 0) return undefined;
    return [
      {
        id: "form-fields",
        label: "Field data",
        description: state.formName
          ? `From "${state.formName}"`
          : "From your Facebook lead form",
        variables: vars,
        defaultExpanded: true,
      },
    ];
  }, [formFields, state.formName]);

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


  // ─── Validation ────────────────────────────────────────────────────────────
  const triggerFilled =
    !!state.accountId && !!state.pageId && !!state.formId;
  const destinationFilled = state.destinations.length > 0;
  const mappingFilled = useMemo(() => {
    if (!destinationFilled) return false;
    for (const dest of state.destinations) {
      const destRecord = targetWebsites?.find((t) => t.id === dest.id);
      const manifest = resolveDestManifest(destRecord, dest.templateType, dest.name, appManifests);
      if (manifest && manifest.leadFields.length > 0) {
        for (const lf of manifest.leadFields) {
          if (!lf.required) continue;
          if (lf.mode === "auto" && !dest.leadFields[lf.key]) return false;
          if (lf.mode === "static" && !(dest.staticValues[lf.key] ?? "").trim()) {
            return false;
          }
          // mode="secret" — filled at destination creation; nothing to validate here.
        }
      } else if (dest.templateType === "custom") {
        if (dest.customMappings.length === 0) return false;
        if (
          !dest.customMappings.every(
            (m) =>
              !m.to.trim() ||
              (m.from !== null ? !!m.from : !!m.staticValue?.trim()),
          )
        )
          return false;
      }
    }
    return true;
  }, [destinationFilled, state.destinations, targetWebsites]);
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

  // We intentionally preserve `staticValues` across trigger changes: offer_id /
  // stream / etc. are per-integration constants the user picked for this
  // destination and have nothing to do with which FB form is the trigger. Only
  // the FB-field mappings (`leadFields`, `customMappings`) need to be reset.
  const setAccount = (id: number, name: string) => {
    patch({
      accountId: id,
      accountName: name,
      pageId: "",
      pageName: "",
      formId: "",
      formName: "",
      destinations: state.destinations.map((d) => ({
        ...d,
        leadFields: {},
        customMappings: [],
      })),
    });
  };
  const setPage = (id: string, name: string) => {
    patch({
      pageId: id,
      pageName: name,
      formId: "",
      formName: "",
      destinations: state.destinations.map((d) => ({
        ...d,
        leadFields: {},
        customMappings: [],
      })),
    });
  };
  const setForm = (id: string, name: string) => {
    patch({
      formId: id,
      formName: name,
      destinations: state.destinations.map((d) => ({
        ...d,
        leadFields: {},
        customMappings: [],
      })),
    });
  };

  /** Add a destination to the list if not already present. */
  const addDestination = (id: number, name: string, templateType: string) => {
    // Read destination record from already-fetched list (may be undefined if list
    // hasn't loaded yet — auto-populate effect will fill in once it does).
    const destRecord = targetWebsites?.find((t) => t.id === id);
    const manifest = resolveDestManifest(destRecord, templateType, name, appManifests);
    const fields = formFields ?? [];

    setState((s) => {
      if (s.destinations.some((d) => d.id === id)) return s;
      const leadFields: Record<string, string> = {};
      const staticValues: Record<string, string> = {};

      if (manifest) {
        for (const lf of manifest.leadFields) {
          if (lf.mode === "auto") {
            if (lf.autoDetect === "name") {
              const m = autoMatchField(fields, NAME_PATTERNS);
              if (m) leadFields[lf.key] = m;
            } else if (lf.autoDetect === "phone") {
              const m = autoMatchField(fields, PHONE_PATTERNS);
              if (m) leadFields[lf.key] = m;
            }
          } else if (lf.mode === "static") {
            // Pre-fill with the admin's default so the user sees what will be
            // sent and can override per-integration without retyping common
            // values. Empty string when no default exists keeps the field
            // editable but shows the placeholder.
            staticValues[lf.key] = lf.staticDefault ?? "";
          }
          // mode="secret" → value comes from the saved credential at delivery;
          // nothing to seed into wizard state.
        }
      }

      return {
        ...s,
        destinations: [
          ...s.destinations,
          { id, name, templateType, leadFields, staticValues, customMappings: [] },
        ],
      };
    });
  };

  /** Remove a destination from the list by id. */
  const removeDestination = (id: number) => {
    setState((s) => ({
      ...s,
      destinations: s.destinations.filter((d) => d.id !== id),
    }));
  };

  /** Update a single FROM_LEAD field for a destination (manifest-driven). */
  const updateLeadField = (destId: number, fieldKey: string, formFieldKey: string) =>
    setState((s) => ({
      ...s,
      destinations: s.destinations.map((d) =>
        d.id === destId
          ? { ...d, leadFields: { ...d.leadFields, [fieldKey]: formFieldKey } }
          : d,
      ),
    }));

  /** Update a mode="static" value for a destination — the user typing a
   *  per-integration offer_id / stream / custom variable. Saved to
   *  integration.config.variableFields on submit. */
  const updateStaticValue = (destId: number, fieldKey: string, value: string) =>
    setState((s) => ({
      ...s,
      destinations: s.destinations.map((d) =>
        d.id === destId
          ? { ...d, staticValues: { ...d.staticValues, [fieldKey]: value } }
          : d,
      ),
    }));

  /** Update custom mappings (FieldMappingsEditor rows) for a destination. */
  const updateCustomMapping = (destId: number, index: number, p: Partial<FieldMapping>) =>
    setState((s) => ({
      ...s,
      destinations: s.destinations.map((d) => {
        if (d.id !== destId) return d;
        const next = [...d.customMappings];
        const ex = next[index];
        if (!ex) return d;
        next[index] = { ...ex, ...p };
        return { ...d, customMappings: next };
      }),
    }));
  const addCustomMappingFormRow = (destId: number) =>
    setState((s) => ({
      ...s,
      destinations: s.destinations.map((d) =>
        d.id === destId
          ? { ...d, customMappings: [...d.customMappings, { from: "", to: "" }] }
          : d,
      ),
    }));
  const addCustomMappingStaticRow = (destId: number) =>
    setState((s) => ({
      ...s,
      destinations: s.destinations.map((d) =>
        d.id === destId
          ? { ...d, customMappings: [...d.customMappings, { from: null, to: "", staticValue: "" }] }
          : d,
      ),
    }));
  const removeCustomMapping = (destId: number, index: number) =>
    setState((s) => ({
      ...s,
      destinations: s.destinations.map((d) =>
        d.id === destId
          ? { ...d, customMappings: d.customMappings.filter((_, i) => i !== index) }
          : d,
      ),
    }));

  // ─── Save handler ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!canSave) return;
    const primaryDest_ = state.destinations[0]!;

    // Build fieldMappings from primary destination's manifest leadFields.
    // For custom destinations, use customMappings rows.
    let fieldMappings: FieldMapping[];
    if (primaryManifest && primaryManifest.leadFields.length > 0) {
      fieldMappings = serializeFieldMappings(
        Object.entries(primaryDest_.leadFields)
          .filter(([, from]) => from)
          .map(([to, from]) => ({ from, to })),
      );
    } else {
      fieldMappings = serializeFieldMappings(primaryDest_.customMappings);
    }

    // Extract legacy compat fields from fieldMappings
    const nameMapping = fieldMappings.find((m) => m.to === "name" && m.from);
    const phoneMapping = fieldMappings.find((m) => m.to === "phone" && m.from);

    // Build variableFields — the per-integration values that sendLeadViaTemplate
    // substitutes into admin template bodyFields via {{key}} tokens.
    //
    // Layering (last-write-wins):
    //   1. Destination's admin defaults (targetWebsite.templateConfig[key])
    //      keep working for destinations that were never edited in the wizard
    //      (preserves existing behaviour for pre-Commit-8 integrations).
    //   2. The wizard's `staticValues` overrides every key the user actually
    //      touched in the mapping grid. Empty strings are intentionally sent
    //      so admins can blank out a destination-level default per integration.
    const tplCfg = (primaryDestRecord?.templateConfig ?? {}) as Record<string, unknown>;
    const varKeys =
      ((primaryDestRecord?.variableFields ?? []) as string[]).length > 0
        ? (primaryDestRecord!.variableFields as string[])
        : (primaryManifest?.connectionKeys ?? []);
    const variableFields: Record<string, string> = {};
    for (const key of varKeys) {
      const v = tplCfg[key];
      if (typeof v === "string" && v) variableFields[key] = v;
    }
    for (const [key, value] of Object.entries(primaryDest_.staticValues)) {
      if (typeof value === "string") variableFields[key] = value;
    }

    const config = {
      facebookAccountId: state.accountId,
      pageId: state.pageId,
      pageName: state.pageName,
      formId: state.formId,
      formName: state.formName,
      fieldMappings,
      // Legacy compat
      nameField: nameMapping?.from ?? "",
      phoneField: phoneMapping?.from ?? "",
      targetWebsiteId: primaryDestId,
      targetWebsiteName: primaryDestName,
      targetTemplateType: primaryDestType,
      variableFields,
    };
    const destinationIds = state.destinations.map((d) => d.id);
    try {
      if (isEditMode) {
        await updateMutation.mutateAsync({
          id: editId!,
          name: state.integrationName.trim(),
          config,
          destinationIds,
        });
      } else {
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
      }
    } catch (err) {
      console.error("[IntegrationWizardV2] save failed", err);
    }
  };

  const isSaving =
    subscribeMutation.isPending || createMutation.isPending || updateMutation.isPending;

  // ─── Derived: primary destination's DB record ──────────────────────────────
  const primaryDestRecord = useMemo(
    () => targetWebsites?.find((t) => t.id === primaryDestId) ?? null,
    [targetWebsites, primaryDestId],
  );

  // ─── Derived: primary manifest — DB template first, then server apps ──────
  const primaryManifest = useMemo(
    () => resolveDestManifest(primaryDestRecord, primaryDestType, primaryDestName, appManifests),
    [primaryDestRecord, primaryDestType, primaryDestName, appManifests],
  );

  // ─── Derived: read-only connection config shown in Step 2 ──────────────────
  const connectionConfig = useMemo(() => {
    if (!primaryDestRecord) return {};
    const cfg = (primaryDestRecord.templateConfig ?? {}) as Record<string, unknown>;
    const result: Record<string, string> = {};
    // Non-secret display keys: from DB variableFields OR manifest connectionKeys
    const displayKeys =
      ((primaryDestRecord.variableFields ?? []) as string[]).length > 0
        ? (primaryDestRecord.variableFields as string[])
        : (primaryManifest?.connectionKeys ?? []);
    for (const key of displayKeys) {
      const v = cfg[key];
      if (typeof v === "string" && v) result[key] = v;
    }
    // Masked secrets (always shown if present)
    if (typeof cfg.apiKeyMasked === "string") result.api_key = cfg.apiKeyMasked;
    if (typeof cfg.botTokenMasked === "string") result.bot_token = cfg.botTokenMasked;
    return result;
  }, [primaryDestRecord, primaryManifest]);

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
          <span className="text-sm text-muted-foreground">
            {isEditMode ? "Edit integration" : "New integration"}
          </span>
        </div>

        <h1 className="text-xl font-bold tracking-tight mb-8">
          {isEditMode ? (editIntegration?.name ?? "Edit integration") : "New Zap"}
        </h1>

        {/* Loading state in edit mode while data is being fetched */}
        {isEditMode && !stateInitialized && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading integration…
          </div>
        )}

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

            {/* Continue — field mapping lives in Step 2 per destination */}
            {triggerFilled && (
              <div className="flex justify-end pt-4 mt-2 border-t">
                <Button size="sm" onClick={() => setActiveStep(2)}>
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
            /* Only opens after Continue on the trigger (activeStep=2).
               Keeping it closed while the trigger is still active matches
               the Zapier/Make flow the user asked for: trigger → Continue
               → downward connector → "+ Add action" revealed. */
            isOpen={activeStep === 2}
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
                triggerVariables={triggerVariableGroups}
              />
            ) : !destinationFilled ? (
              /* ── Empty Action step: one big "+ Add action" CTA ──
                   Matches the Zapier/Make.com pattern the user approved:
                   after Continue on the trigger, step 2 just shows this
                   button — the full app picker lives inside the modal so
                   the wizard stays uncluttered. */
              <div className="flex flex-col items-center justify-center py-6">
                <button
                  type="button"
                  onClick={() => setActionPickerOpen(true)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary/30 bg-primary/5 px-10 py-8 transition-all",
                    "hover:border-primary/60 hover:bg-primary/10 active:scale-[0.99]",
                  )}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Plus className="h-5 w-5" strokeWidth={2.5} />
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    Add action
                  </span>
                  <span className="max-w-[220px] text-center text-[11px] leading-snug text-muted-foreground">
                    Choose where each new Facebook lead should go
                  </span>
                </button>
              </div>
            ) : (
              /* ── Destination selected → chip view + mapping + publish ── */
              <>
                {/* Destination chip list (picker UI lives in the modal now) */}
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
                    onAddAnother={() => setActionPickerOpen(true)}
                  />
                </div>

                {/* AppManifest-driven field mapping (Make.com / Zapier level) */}
                {destinationFilled && primaryManifest && (
                  <AppManifestMapper
                    manifest={primaryManifest}
                    destEntry={primaryDest!}
                    formFields={formFields ?? []}
                    loadingFields={loadingFields}
                    connectionConfig={connectionConfig}
                    onUpdateLeadField={(key, formField) =>
                      updateLeadField(primaryDest!.id, key, formField)
                    }
                    onUpdateStaticValue={(key, value) =>
                      updateStaticValue(primaryDest!.id, key, value)
                    }
                    onUpdateCustomMapping={(i, p) =>
                      updateCustomMapping(primaryDest!.id, i, p)
                    }
                    onAddCustomFormRow={() => addCustomMappingFormRow(primaryDest!.id)}
                    onAddCustomStaticRow={() => addCustomMappingStaticRow(primaryDest!.id)}
                    onRemoveCustomMapping={(i) => removeCustomMapping(primaryDest!.id, i)}
                  />
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

                    {/* Publish / Save row */}
                    <div className="flex items-center justify-between pt-1">
                      <p className="text-xs text-muted-foreground">
                        {canSave
                          ? isEditMode
                            ? "Ready to save changes."
                            : "Ready to publish — activates immediately."
                          : "Fill in Name and Phone fields to continue."}
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
                          {isEditMode ? "Save changes" : "Publish"}
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

      {/* Zapier-style app picker modal. Mounted once at the page level so
          opening/closing it preserves all wizard state (trigger choices,
          mapping edits, etc.). */}
      <WizardActionPickerModal
        open={actionPickerOpen}
        onOpenChange={setActionPickerOpen}
        onDestinationReady={(id, name, templateType) => {
          addDestination(id, name, templateType);
          setActiveStep(2);
        }}
        onPickManifestApp={(appKey) => {
          // Sheets / Telegram / Custom HTTP still need the multi-step inline
          // creator (OAuth popup, bot token form, webhook builder). Hand off
          // to the existing flow instead of duplicating those forms inside
          // the picker.
          setInlineCreatorAppKey(appKey);
          setActiveStep(2);
        }}
      />
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
  /**
   * Optional — when provided, the chip view's "Add another destination"
   * link opens the Zapier-style WizardActionPickerModal instead of the
   * embedded picker. Falls back to the internal picker when undefined.
   */
  onAddAnother?: () => void;
}


function DestinationEditor({
  destinations,
  loading,
  selectedIds,
  onToggle,
  onOpenCreatorForApp,
  onAddAnother,
}: DestinationEditorProps) {
  const { data: appList = [] } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const shortcutApps = useMemo(
    () =>
      appList.filter(
        (a) =>
          a.availability !== "deprecated" &&
          isSupportedAppKey(a.key) &&
          (a.modules[0]?.fields?.length ?? 0) > 0,
      ),
    [appList],
  );

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
            onClick={() => (onAddAnother ? onAddAnother() : setShowPicker(true))}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add another destination
          </button>
          <button
            type="button"
            onClick={() => (onAddAnother ? onAddAnother() : setShowPicker(true))}
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
          {shortcutApps.map((app) => {
            const Icon = resolveAppIcon(app.icon);
            const desc = app.description
              ? app.description.length > 38
                ? app.description.slice(0, 38) + "…"
                : app.description
              : "";
            return (
              <button
                key={app.key}
                type="button"
                onClick={() => onOpenCreatorForApp(app.key)}
                className={cn(
                  "group flex flex-col items-center gap-2.5 rounded-xl border bg-background p-3.5 text-center transition-all hover:shadow-sm",
                  appIconRingClass(app.category),
                )}
              >
                <div
                  className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-xl transition-transform group-hover:scale-105",
                    appIconBgClass(app.category),
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-xs font-semibold leading-tight">
                    {app.name}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                    {desc}
                  </div>
                </div>
              </button>
            );
          })}
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


// ─── AppManifestMapper ─────────────────────────────────────────────────────────
// Make.com / Zapier level: per-service field mapping driven by the manifest
// returned by resolveDestManifest (DB template or server manifest).
//
//  For manifest services (sotuvchi, 100k, telegram …):
//    FIELD MAPPING
//      Ism *    ← [Full name (full_name) ▼]
//      Telefon* ← [Phone number        ▼]
//    CONNECTION CONFIG  (read-only)
//      offer_id: 456   stream: main   api_key: ••••
//
//  For "custom" type: falls back to the FieldMappingsEditor (dynamic rows).

// ─── FieldMappingRow — one unified row in the Make.com-style mapping grid ─────
//
// The row shape stays constant across all three modes so the grid reads as a
// vertical table: LABEL → WIDGET. The widget is what switches:
//   • auto   → <Select> of FB form fields + metadata (with an inline
//              "Empty — pick a form field" warning when no match is set yet)
//   • static → <Input> with the admin default as placeholder + a small muted
//              helper line that surfaces the default when the user clears it
//   • secret → a read-only chip with the masked credential + a Lock icon so
//              users instantly recognise it's coming from the connection
//              they configured at destination creation time.

interface FieldMappingRowProps {
  field: import("./lead-routing/shared").AppManifestLeadField;
  leadValue: string;
  staticValue: string;
  formFields: Array<{ key: string; label?: string | null }>;
  onUpdateLeadField: (formFieldKey: string) => void;
  onUpdateStaticValue: (value: string) => void;
}

function FieldMappingRow({
  field,
  leadValue,
  staticValue,
  formFields,
  onUpdateLeadField,
  onUpdateStaticValue,
}: FieldMappingRowProps) {
  const containerCls = cn(
    "grid grid-cols-[120px_12px_1fr] items-center gap-2 rounded-lg border px-3 py-2",
    field.required
      ? "border-primary/25 bg-primary/4"
      : "border-border bg-background",
  );

  const labelCell = (
    <div className="text-xs font-medium leading-tight">
      {field.label}
      {field.required && <span className="text-destructive ml-0.5">*</span>}
    </div>
  );

  const arrow = (
    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
  );

  if (field.mode === "secret") {
    return (
      <div
        className={cn(
          containerCls,
          "border-border bg-muted/20", // secrets never look "required empty"
        )}
      >
        {labelCell}
        {arrow}
        <div
          className="flex items-center gap-2 rounded-md border border-dashed bg-background px-2.5 py-1.5 text-xs"
          title="This value comes from the connection you configured on the destination."
        >
          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-mono text-muted-foreground truncate">
            {field.secretLabel ?? "••••"}
          </span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
            From connection
          </span>
        </div>
      </div>
    );
  }

  if (field.mode === "static") {
    const showDefaultHint =
      !staticValue && !!field.staticDefault;
    return (
      <div className={containerCls}>
        {labelCell}
        {arrow}
        <div className="space-y-0.5">
          <Input
            className="h-8 text-xs"
            placeholder={field.staticDefault || `Enter ${field.label.toLowerCase()}…`}
            value={staticValue}
            onChange={(e) => onUpdateStaticValue(e.target.value)}
          />
          {showDefaultHint && (
            <div className="text-[10px] text-muted-foreground/80 pl-0.5">
              Default:{" "}
              <span className="font-mono text-muted-foreground">
                {field.staticDefault}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // mode === "auto" — Make.com-style grouped, searchable, collapsible picker.
  // Groups are built from the two FB sources (form questions + lead metadata)
  // and handed to the shared GroupedFieldPicker. Empty-state is handled by
  // the picker itself via the `emptyMessage` prop when no options exist.
  const sourceGroups: GroupedFieldPickerGroup[] =
    formFields.length === 0
      ? []
      : [
          {
            id: "form-fields",
            label: "Form fields",
            defaultExpanded: true,
            options: formFields.map((f) => ({
              key: f.key,
              label: f.label || f.key,
            })),
          },
          {
            id: "fb-metadata",
            label: "FB metadata",
            defaultExpanded: true,
            options: FB_METADATA_FIELDS.map((m) => ({
              key: m.key,
              label: FB_METADATA_LABELS[m.key] ?? m.key,
            })),
          },
        ];

  return (
    <div className={containerCls}>
      {labelCell}
      {arrow}
      <GroupedFieldPicker
        groups={sourceGroups}
        value={leadValue || null}
        onChange={onUpdateLeadField}
        placeholder="Pick FB form field…"
        emptyMessage="Pick a form in Step 1 to see fields."
      />
    </div>
  );
}

interface AppManifestMapperProps {
  manifest: import("./lead-routing/shared").AppManifestService;
  destEntry: DestinationEntry;
  formFields: Array<{ key: string; label?: string | null }>;
  loadingFields: boolean;
  connectionConfig: Record<string, string>;
  onUpdateLeadField: (key: string, formField: string) => void;
  onUpdateStaticValue: (key: string, value: string) => void;
  onUpdateCustomMapping: (index: number, p: Partial<FieldMapping>) => void;
  onAddCustomFormRow: () => void;
  onAddCustomStaticRow: () => void;
  onRemoveCustomMapping: (index: number) => void;
}

/**
 * Make.com / Zapier-style field mapping grid.
 *
 * The heart of this component is the `manifest.leadFields.map(...)` loop: it
 * renders ONE row per destination key, picking the widget based on `lf.mode`:
 *   • mode="auto"   → Select of Facebook form fields + metadata (FROM_LEAD)
 *   • mode="static" → Text input with admin default placeholder (user-editable)
 *   • mode="secret" → Read-only chip sourced from the saved connection
 *
 * For legacy destinations whose manifest only carries auto fields the grid
 * looks identical to the pre-dynamic-mapping version, so this is a no-op for
 * Telegram / Sheets / UZ-CPA-fallback admin templates.
 */
function AppManifestMapper({
  manifest,
  destEntry,
  formFields,
  loadingFields,
  connectionConfig,
  onUpdateLeadField,
  onUpdateStaticValue,
  onUpdateCustomMapping,
  onAddCustomFormRow,
  onAddCustomStaticRow,
  onRemoveCustomMapping,
}: AppManifestMapperProps) {
  // Admin-managed templates (sotuvchi, 100k, …) also have templateType="custom"
  // in the DB for legacy compat — but they carry leadFields from the template.
  // Use leadFields.length as the true signal, not manifest.id.
  const isCustom = manifest.leadFields.length === 0;
  const hasConnection = Object.keys(connectionConfig).length > 0;
  // Hide the legacy "Connection config" box whenever secret rows already
  // surface the same information inline — prevents duplicate UI for new
  // admin templates that expose userVisibleFields.
  const hasInlineSecretRow = manifest.leadFields.some((lf) => lf.mode === "secret");
  // Auto rows can't be filled until the trigger form fields arrive. We still
  // render them (with disabled Select) but flag the situation with a banner so
  // static / secret rows stay accessible without hiding the whole grid.
  const hasAutoRow = manifest.leadFields.some((lf) => lf.mode === "auto");
  const needsFormFields = hasAutoRow && formFields.length === 0 && !loadingFields;

  return (
    <div className="border-t mt-5 pt-5 space-y-5">
      {/* ── Unified per-destination field mapping grid ── */}
      {!isCustom && manifest.leadFields.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Field mapping
            <span className="ml-1.5 normal-case font-normal">
              ({manifest.label})
            </span>
          </div>

          {loadingFields ? (
            <LoadingBar />
          ) : (
            <>
              {needsFormFields && (
                <EmptyHint message="Pick a form in Step 1 to fill the highlighted fields." />
              )}
              <div className="space-y-2">
                {manifest.leadFields.map((lf) => (
                  <FieldMappingRow
                    key={lf.key}
                    field={lf}
                    leadValue={destEntry.leadFields[lf.key] ?? ""}
                    staticValue={destEntry.staticValues[lf.key] ?? ""}
                    formFields={formFields}
                    onUpdateLeadField={(v) => onUpdateLeadField(lf.key, v)}
                    onUpdateStaticValue={(v) => onUpdateStaticValue(lf.key, v)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Custom (dynamic) type uses full FieldMappingsEditor ── */}
      {isCustom && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Field mapping
            <span className="ml-1.5 normal-case font-normal">(Custom Webhook)</span>
          </div>
          {loadingFields ? (
            <LoadingBar />
          ) : (
            <FieldMappingsEditor
              formFields={formFields}
              mappings={destEntry.customMappings}
              onUpdate={onUpdateCustomMapping}
              onRemove={onRemoveCustomMapping}
              onAddFormRow={onAddCustomFormRow}
              onAddStaticRow={onAddCustomStaticRow}
            />
          )}
        </div>
      )}

      {/* ── Connection config (read-only, legacy path only) ──
           Hidden when secret rows are already inline in the mapping grid so
           there's only one place to look for the api_key / bot_token badge. */}
      {hasConnection && !hasInlineSecretRow && (
        <div className="space-y-2 rounded-xl border bg-muted/30 px-3 py-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            <span className="text-xs font-semibold">
              Connection
              <span className="ml-1 font-normal text-muted-foreground">
                ({destEntry.name})
              </span>
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {Object.entries(connectionConfig).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground font-mono">{k}:</span>
                <span
                  className={cn(
                    "font-mono",
                    v.startsWith("•") ? "text-muted-foreground" : "font-medium",
                  )}
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FieldMappingsEditor ───────────────────────────────────────────────────────
// Make.com-style row-per-field mapper.  Every row:
//   [FB form field ▼  OR  static value input]  →  [destination key]  [×]
// Rows whose `to` is "name" or "phone" are highlighted as required.

interface FieldMappingsEditorProps {
  formFields: Array<{ key: string; label?: string | null }>;
  mappings: FieldMapping[];
  onUpdate: (index: number, patch: Partial<FieldMapping>) => void;
  onRemove: (index: number) => void;
  onAddFormRow: () => void;
  onAddStaticRow: () => void;
}

function FieldMappingsEditor({
  formFields,
  mappings,
  onUpdate,
  onRemove,
  onAddFormRow,
  onAddStaticRow,
}: FieldMappingsEditorProps) {
  return (
    <div className="space-y-1.5">
      {/* Column headers */}
      <div className="grid grid-cols-[1fr_12px_120px_28px] items-center gap-2 px-1 pb-0.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Facebook form field / static value
        </div>
        <div />
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Destination key
        </div>
        <div />
      </div>

      {/* Rows */}
      {mappings.map((m, i) => {
        const isRequired = m.to === "name" || m.to === "phone";
        return (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[1fr_12px_120px_28px] items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors",
              isRequired
                ? "border-primary/25 bg-primary/4"
                : "border-border bg-background hover:bg-muted/20",
            )}
          >
            {/* Source: form field dropdown OR static value input */}
            {m.from !== null ? (
              <GroupedFieldPicker
                groups={[
                  {
                    id: "form-fields",
                    label: "Form fields",
                    defaultExpanded: true,
                    options: formFields.map((f) => ({
                      key: f.key,
                      label: f.label || f.key,
                    })),
                  },
                  {
                    id: "fb-metadata",
                    label: "FB metadata",
                    defaultExpanded: true,
                    options: FB_METADATA_FIELDS.map((mf) => ({
                      key: mf.key,
                      label: FB_METADATA_LABELS[mf.key] ?? mf.key,
                    })),
                  },
                ]}
                value={m.from || null}
                onChange={(v) => onUpdate(i, { from: v })}
                placeholder="Pick form field…"
                className="border-0 shadow-none bg-transparent px-1"
              />
            ) : (
              <Input
                className="h-8 text-xs border-0 shadow-none bg-transparent px-1 focus-visible:ring-0"
                placeholder="Static value…"
                value={m.staticValue ?? ""}
                onChange={(e) => onUpdate(i, { staticValue: e.target.value })}
              />
            )}

            {/* Arrow */}
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />

            {/* Destination key */}
            <Input
              className={cn(
                "h-8 text-xs font-mono border-0 shadow-none bg-transparent px-1 focus-visible:ring-0",
                isRequired && "font-semibold text-primary",
              )}
              placeholder="dest_key"
              value={m.to}
              onChange={(e) => onUpdate(i, { to: e.target.value })}
            />

            {/* Remove */}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive transition-colors"
              aria-label="Remove row"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {/* Add row actions */}
      <div className="flex items-center gap-1.5 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={onAddFormRow}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add form field
        </Button>
        <span className="text-muted-foreground/40 text-xs">·</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={onAddStaticRow}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Static value
        </Button>
      </div>
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

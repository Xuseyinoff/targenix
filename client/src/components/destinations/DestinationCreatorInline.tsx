/**
 * DestinationCreatorInline — Zapier-style inline destination creator.
 *
 * Renders directly inside the wizard's Step 2 card (no Sheet/drawer).
 * The parent switches its content between the normal destination-picker
 * view and this component when the user clicks an app shortcut card or
 * the "new destination" option in the picker.
 *
 * Flow:
 *   1. "pick"      — search + app grid (same as drawer's AppPicker).
 *   2. "configure" — name input + DynamicForm for the selected app.
 *
 * When `initialAppKey` is supplied the picker step is skipped entirely
 * and the component starts in "configure" mode for that app.
 */

import * as React from "react";
import { ArrowLeft, Loader2, Search, X } from "lucide-react";
import { SAMPLE_LEAD_CONTEXT } from "@/hooks/useTransformPreview";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  DynamicForm,
  seedInitialValues,
  validateFields,
  type FieldValues,
} from "@/components/dynamic-form";
import type {
  ConfigField,
  AvailableVariable,
  VariableGroup,
} from "@/components/dynamic-form";
import { AppIcon, appBrandIconTileClass } from "./appIcons";
import {
  APP_KEY_TO_TEMPLATE_TYPE,
  buildCreatePayload,
  isSupportedAppKey,
} from "./createPayload";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DestinationCreatorInlineProps {
  /**
   * When provided the component starts in "configure" mode for this app key
   * (e.g. "telegram", "google-sheets"). Applied once the app manifest loads.
   * Pass `undefined` to start in "pick" mode.
   */
  initialAppKey?: string;
  /**
   * Edit mode. When set, the component fetches the destination, pre-fills the
   * configure form with its values, and calls `destinations.update` (or
   * `destinations.updateFromTemplate` for legacy CPA templateId-bearing rows)
   * on save instead of `destinations.create`. The app-type picker and the
   * connection-picker field are locked — switching either is a re-creation,
   * not an edit. Pass `undefined` for create mode (default).
   */
  editingDestinationId?: number;
  /**
   * Optional in edit mode (only one path fires). Required in create mode.
   * Kept optional in the type so call sites that only do edits can omit it.
   */
  onCreated?: (result: {
    id: number;
    name: string;
    templateType: string;
    category: string;
  }) => void;
  /** Called after a successful edit save. */
  onSaved?: (destinationId: number) => void;
  /** Called when the user clicks "Cancel" or "← Back" from the pick step. */
  onCancel: () => void;
  /**
   * Extra variable groups to surface in the per-field Map toggle on top of
   * the app-specific "Lead metadata" baseline. Typically populated by the
   * integration wizard from the selected Facebook lead form's questions
   * (e.g. "Field data" → Full name, Phone number, Vehicle, Custom 1, …).
   *
   * When omitted, only the adapter's metadata group is shown — safe default
   * for the standalone /destinations page where no trigger is bound yet.
   */
  triggerVariables?: VariableGroup[];
}

interface AppListItem {
  key: string;
  name: string;
  version: string;
  icon: string | null;
  category: string;
  description: string | null;
  connectionType: string;
  modules: Array<{
    key: string;
    name: string;
    kind: "action";
    description?: string;
    fields?: ConfigField[];
  }>;
  availability: "stable" | "beta" | "deprecated";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DestinationCreatorInline({
  initialAppKey,
  editingDestinationId,
  onCreated,
  onSaved,
  onCancel,
  triggerVariables,
}: DestinationCreatorInlineProps) {
  const isEditMode = editingDestinationId != null;
  const [step, setStep] = React.useState<"pick" | "configure">(
    initialAppKey || isEditMode ? "configure" : "pick",
  );
  const [selectedApp, setSelectedApp] = React.useState<AppListItem | null>(
    null,
  );
  const [search, setSearch] = React.useState("");
  const [destName, setDestName] = React.useState("");
  const [formValues, setFormValues] = React.useState<FieldValues>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [pendingAppKey, setPendingAppKey] = React.useState<string | null>(
    initialAppKey ?? null,
  );

  const utils = trpc.useUtils();
  const { data: apps = [], isLoading: loadingApps } =
    trpc.apps.list.useQuery();

  const createMutation = trpc.destinations.create.useMutation();
  const updateMutation = trpc.destinations.update.useMutation();
  const updateFromTemplateMutation =
    trpc.destinations.updateFromTemplate.useMutation();

  // Edit mode — load the destination so we can pre-fill the form. We reuse
  // the existing list query (same data the parent /integrations page already
  // has cached) instead of adding a focused getById endpoint.
  const { data: allDestinations = [] } = trpc.destinations.list.useQuery(
    undefined,
    { enabled: isEditMode },
  );
  const editingDestination = React.useMemo(
    () =>
      isEditMode
        ? allDestinations.find((d) => d.id === editingDestinationId) ?? null
        : null,
    [allDestinations, editingDestinationId, isEditMode],
  );
  const editingHasTemplateId =
    !!(editingDestination as { templateId?: number | null } | null)?.templateId;
  // `editPrefilled` guards the prefill effect so we don't clobber the user's
  // in-progress edits if `editingDestination` re-renders.
  const [editPrefilled, setEditPrefilled] = React.useState(false);

  const supportedApps = React.useMemo(
    () =>
      apps.filter((a) => {
        if (a.availability === "deprecated") return false;
        if (!isSupportedAppKey(a.key)) return false;
        const fields = a.modules[0]?.fields;
        return Array.isArray(fields) && fields.length > 0;
      }),
    [apps],
  );

  // Auto-advance to configure step when apps load and we have a pending key.
  React.useEffect(() => {
    if (!pendingAppKey || loadingApps || supportedApps.length === 0) return;
    const app = supportedApps.find((a) => a.key === pendingAppKey);
    if (!app) return;
    const fields = app.modules[0]?.fields ?? [];
    setSelectedApp(app);
    setFormValues(seedInitialValues(fields, undefined));
    setFormErrors({});
    setDestName("");
    setStep("configure");
    setPendingAppKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAppKey, loadingApps, supportedApps]);

  // Edit-mode prefill — runs once `destinations.list` + `apps.list` have both
  // loaded. Finds the matching app manifest, reconstructs form values from
  // the destination's templateConfig + connectionId, and seats them on the
  // configure step. Legacy CPA destinations (templateId set) fall through to
  // a simplified "name only" UI rendered below — no full form prefill.
  React.useEffect(() => {
    if (!isEditMode || editPrefilled || !editingDestination) return;
    if (editingHasTemplateId) {
      // Template-based destinations are edited via updateFromTemplate (name
      // only — secrets live on the linked connection now). Prefill the name
      // and stop; the configure UI below renders a stripped-down form.
      setDestName(editingDestination.name ?? "");
      setEditPrefilled(true);
      return;
    }
    if (loadingApps || supportedApps.length === 0) return;
    const app = supportedApps.find((a) => a.key === editingDestination.appKey);
    if (!app) {
      // Unsupported / deprecated app — leave selectedApp null so the editor
      // renders the "not supported" notice (see configure step below).
      setEditPrefilled(true);
      return;
    }
    const fields = app.modules[0]?.fields ?? [];
    const cfg =
      (editingDestination.templateConfig as Record<string, unknown> | null) ??
      {};
    // connectionId lives on the destination row, not in templateConfig — copy
    // it across so the (now locked) connection picker resolves to the right
    // row and dependent loaders (sheet headers, etc.) keep working.
    const seed: Record<string, unknown> = { ...cfg };
    const connId = (editingDestination as { connectionId?: number | null })
      .connectionId;
    if (typeof connId === "number") seed.connectionId = connId;

    setSelectedApp(app);
    setFormValues(seedInitialValues(fields, seed as FieldValues));
    setFormErrors({});
    setDestName(editingDestination.name ?? "");
    setStep("configure");
    setEditPrefilled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEditMode,
    editPrefilled,
    editingDestination,
    editingHasTemplateId,
    loadingApps,
    supportedApps,
  ]);

  const filteredApps = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return supportedApps;
    return supportedApps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    );
  }, [supportedApps, search]);

  const groupedApps = React.useMemo(() => {
    const byCategory = new Map<string, AppListItem[]>();
    for (const app of filteredApps) {
      const arr = byCategory.get(app.category) ?? [];
      arr.push(app);
      byCategory.set(app.category, arr);
    }
    return Array.from(byCategory.entries());
  }, [filteredApps]);

  const handlePickApp = (app: AppListItem) => {
    const fields = app.modules[0]?.fields ?? [];
    setSelectedApp(app);
    setFormValues(seedInitialValues(fields, undefined));
    setFormErrors({});
    setDestName("");
    setStep("configure");
  };

  const handleBack = () => {
    setStep("pick");
    setSelectedApp(null);
    setFormValues({});
    setFormErrors({});
  };

  const handleSave = async () => {
    // ── Edit mode: legacy CPA template (name-only update) ────────────────
    if (isEditMode && editingHasTemplateId && editingDestinationId) {
      setFormErrors({});
      const name = destName.trim();
      if (!name) {
        toast.error("Name is required");
        return;
      }
      try {
        await updateFromTemplateMutation.mutateAsync({
          id: editingDestinationId,
          name,
        });
        await utils.destinations.list.invalidate();
        toast.success("Destination updated");
        onSaved?.(editingDestinationId);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update destination",
        );
      }
      return;
    }

    if (!selectedApp) return;
    const fields = selectedApp.modules[0]?.fields ?? [];

    setFormErrors({});

    const { isValid, errors } = validateFields(fields, formValues);
    if (!isValid) {
      setFormErrors(errors);
      return;
    }

    // Zapier-style: name is optional. If left blank, derive one from the
    // primary config field (sheet name / chatId / URL host) so the user is
    // never forced to invent a label for a single-destination integration.
    const effectiveName =
      destName.trim() || smartDefaultName(selectedApp.key, selectedApp.name, formValues);

    // ── Edit mode: modern destinations (telegram / google-sheets) ────────
    if (isEditMode && editingDestinationId) {
      const updatePayload = buildUpdatePayload(
        selectedApp.key,
        editingDestinationId,
        effectiveName,
        formValues,
      );
      if (!updatePayload) {
        toast.error(
          "Editing this destination type isn't supported here yet. Open /destinations.",
        );
        return;
      }
      try {
        await updateMutation.mutateAsync(
          updatePayload as Parameters<typeof updateMutation.mutateAsync>[0],
        );
        await utils.destinations.list.invalidate();
        toast.success("Destination updated");
        onSaved?.(editingDestinationId);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update destination",
        );
      }
      return;
    }

    // ── Create mode (unchanged) ──────────────────────────────────────────
    let payload: Parameters<typeof createMutation.mutateAsync>[0];
    try {
      payload = buildCreatePayload(selectedApp.key, effectiveName, formValues);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not build payload",
      );
      return;
    }

    try {
      const result = await createMutation.mutateAsync(payload);
      if (!result?.id) {
        toast.error(
          "Destination created but no id returned — please refresh.",
        );
        return;
      }
      await utils.destinations.list.invalidate();
      toast.success(`Created "${result.name ?? effectiveName}"`);
      const fallbackTemplateType = isSupportedAppKey(selectedApp.key)
        ? APP_KEY_TO_TEMPLATE_TYPE[selectedApp.key]
        : "custom";
      onCreated?.({
        id: result.id,
        name: result.name ?? effectiveName,
        // Phase 3 — server now returns `appKey` (not `templateType`). The
        // callback prop name keeps `templateType` for callsite stability; a
        // future cosmetic pass will rename it.
        templateType: result.appKey ?? fallbackTemplateType,
        category: selectedApp.category,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save destination",
      );
    }
  };

  const isSaving =
    createMutation.isPending ||
    updateMutation.isPending ||
    updateFromTemplateMutation.isPending;

  // ─── Pick step ──────────────────────────────────────────────────────────────
  if (step === "pick") {
    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <span className="text-sm font-semibold">Choose destination type</span>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              aria-label="Clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* App grid */}
        {loadingApps ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : groupedApps.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No apps match &ldquo;{search}&rdquo;.
          </p>
        ) : (
          <div className="space-y-4 max-h-80 overflow-y-auto pr-1">
            {groupedApps.map(([category, items]) => (
              <div key={category} className="space-y-1.5">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {prettyCategory(category)}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {items.map((app) => (
                    <button
                      key={app.key}
                      type="button"
                      onClick={() => handlePickApp(app)}
                      className="group flex items-start gap-3 rounded-lg border bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
                    >
                      <div className={appBrandIconTileClass("h-9 w-9 rounded-md")}>
                        <AppIcon name={app.icon ?? "Globe"} className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {app.name}
                          </span>
                          {app.availability === "beta" && (
                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary">
                              Beta
                            </span>
                          )}
                        </div>
                        {app.description && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                            {app.description}
                          </p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Configure step ──────────────────────────────────────────────────────────

  // Edit mode — initial loading. We stay on the configure shell so the
  // dialog doesn't flicker between empty and populated. Once apps + the
  // destination are both fetched, the prefill effect drops us into one of the
  // branches below.
  if (isEditMode && !editPrefilled) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Edit mode — legacy CPA (templateId-bearing) destination. The server-side
  // contract only allows name + secrets here, and secrets live on the linked
  // connection now, so this surface is intentionally minimal: rename only.
  if (isEditMode && editingHasTemplateId && editingDestination) {
    return (
      <div className="space-y-5">
        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border bg-muted/20 p-3",
          )}
        >
          <div className={appBrandIconTileClass("h-9 w-9 rounded-md")}>
            <AppIcon name="Globe" className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{editingDestination.name}</div>
            <div className="text-[11px] text-muted-foreground">
              Template-based destination — only the display name is editable here.
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inline-edit-name" className="text-xs">
            Name
          </Label>
          <Input
            id="inline-edit-name"
            value={destName}
            onChange={(e) => setDestName(e.target.value)}
            disabled={isSaving}
            maxLength={255}
          />
        </div>
        <div className="flex items-center justify-between pt-2 border-t">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save changes
          </Button>
        </div>
      </div>
    );
  }

  // Edit mode — destination's appKey isn't in the inline-supported set
  // (http-api-key / http-request and other future types). The server's
  // `destinations.update` doesn't currently round-trip arbitrary
  // templateConfig overrides for these, so we surface a graceful notice
  // pointing to the admin Destinations page.
  if (isEditMode && !selectedApp) {
    return (
      <div className="space-y-5">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Editing this destination type isn&rsquo;t supported here yet. Use the
          Destinations page to change its configuration.
        </div>
        <div className="flex items-center justify-end pt-2 border-t">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  if (!selectedApp) return null;
  const allFields = selectedApp.modules[0]?.fields ?? [];
  // Edit mode locks the connection picker — switching connection mid-edit is
  // a different workflow (PR 3 of this sprint). We hide the picker field
  // from the dynamic form and surface a read-only note above the form.
  const fields = isEditMode
    ? allFields.filter((f) => f.type !== "connection-picker")
    : allFields;
  const hiddenConnectionField = isEditMode
    ? allFields.find((f) => f.type === "connection-picker") ?? null
    : null;

  return (
    <div className="space-y-5">
      {/* Header with back button — hidden in edit mode (no app picker to
          return to; the only exit is Cancel/Save). */}
      {!isEditMode && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={initialAppKey ? onCancel : handleBack}
            disabled={isSaving}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" />
            {initialAppKey ? "Back to destinations" : "Back"}
          </button>
        </div>
      )}

      {/* App identity banner */}
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border bg-muted/20 p-3",
        )}
      >
        <div className={appBrandIconTileClass("h-9 w-9 rounded-md")}>
          <AppIcon name={selectedApp.icon ?? "Globe"} className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{selectedApp.name}</div>
          {selectedApp.description && (
            <div className="text-[11px] text-muted-foreground line-clamp-1">
              {selectedApp.description}
            </div>
          )}
        </div>
      </div>

      {/* Edit mode: locked-fields explainer. Surfaces the two write-only-on-
          create dimensions (template type + connection) so the user
          understands why those controls aren't visible. */}
      {isEditMode && (
        <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          Some fields are locked — to change template type or connection,
          create a new destination.
          {hiddenConnectionField && (
            <span className="block mt-0.5">
              Linked {hiddenConnectionField.label ?? "connection"} is preserved.
            </span>
          )}
        </div>
      )}

      {/* Destination name — optional in create mode (smart default fills in).
          In edit mode we keep the same field but drop the "(optional)" label. */}
      <div className="space-y-1.5">
        <Label htmlFor="inline-dest-name" className="text-xs">
          Name{" "}
          {!isEditMode && (
            <span className="text-muted-foreground font-normal">(optional)</span>
          )}
        </Label>
        <Input
          id="inline-dest-name"
          value={destName}
          onChange={(e) => setDestName(e.target.value)}
          placeholder={smartDefaultName(selectedApp.key, selectedApp.name, formValues) || `My ${selectedApp.name}`}
          disabled={isSaving}
          maxLength={255}
        />
        {!isEditMode && (
          <p className="text-[11px] text-muted-foreground">
            Shown on your dashboard. Auto-generated if left blank.
          </p>
        )}
      </div>

      {/* Dynamic form fields.
          `availableVariables` wakes up the Make.com-style per-field Map
          toggle. We compose it from two sources so the picker shows BOTH
          the adapter-specific metadata ({{name}}, {{phone}}, …) AND —
          when the wizard supplies one — a "Field data" group built from
          the actual Facebook lead form's questions.

          The adapter metadata list is hand-kept in sync with the server's
          buildVariableContext() / per-adapter ctx, so every key the user
          can pick here is one injectVariables() will actually expand at
          delivery. Introducing a new key here requires a matching server
          change, or the token will render as an empty string. */}
      <DynamicForm
        fields={fields}
        appKey={selectedApp.key}
        values={formValues}
        onChange={setFormValues}
        errors={formErrors}
        disabled={isSaving}
        availableVariables={[
          adapterVariableGroup(selectedApp.key),
          ...(triggerVariables ?? []),
        ]}
        previewCtx={SAMPLE_LEAD_CONTEXT}
      />

      {/* Footer: cancel + save */}
      <div className="flex items-center justify-between pt-2 border-t">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={isSaving}>
          {isSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
          {isEditMode ? "Save changes" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ─── Adapter-specific lead variable catalogues ───────────────────────────────
//
// The set of keys injectVariables() can actually expand DIFFERS between
// adapters. telegramAdapter builds its own ctx ({{full_name}}, {{pageName}}
// …) while plainUrl / httpWebhook use buildVariableContext() in
// affiliateService.ts ({{name}}, {{phone}}, {{lead_id}} …). Exposing the
// wrong set would silently render blanks at delivery, so the picker is
// parametrised per app key.
//
// IMPORTANT: every key below MUST have a matching entry server-side. If you
// add one here without a corresponding ctx.<key> = … line in the adapter,
// users will see the variable in the picker but the outbound request will
// contain an empty string where the token was.

const ADAPTER_METADATA_GROUPS: Record<string, AvailableVariable[]> = {
  // Telegram builds its own ctx in telegramAdapter.ts:
  //   ctx.full_name / phone_number / email / pageName / formName /
  //   campaignName / createdAt, plus spread extraFields.
  telegram: [
    { key: "full_name", label: "Full name" },
    { key: "phone_number", label: "Phone number" },
    { key: "email", label: "Email" },
    { key: "pageName", label: "Page name" },
    { key: "formName", label: "Form name" },
    { key: "campaignName", label: "Campaign name" },
    { key: "createdAt", label: "Lead created at" },
  ],
};

// Default = what affiliateService.buildVariableContext() exposes. Used by
// every plainUrl / httpWebhook / custom-template destination and — safely —
// by any manifest whose adapter wasn't explicitly listed above, because
// those adapters all eventually feed buildCustomBody() which takes the same
// ctx shape.
const DEFAULT_METADATA: AvailableVariable[] = [
  { key: "name", label: "Full name" },
  { key: "phone", label: "Phone number" },
  { key: "email", label: "Email" },
  { key: "lead_id", label: "Lead ID" },
  { key: "page_id", label: "Page ID" },
  { key: "form_id", label: "Form ID" },
];

function adapterVariableGroup(appKey: string): VariableGroup {
  const vars = ADAPTER_METADATA_GROUPS[appKey] ?? DEFAULT_METADATA;
  return {
    id: "lead-meta",
    label: "Lead metadata",
    description: "Always available for this destination",
    variables: vars,
    defaultExpanded: true,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a sensible default destination name from the form values when the
 * user leaves the name field blank. The goal is to drop a recognisable label
 * onto the dashboard ("Sheets · Leads March", "Telegram · @support") instead
 * of an opaque "My Google Sheets" — which is what users were forced to type
 * when name was required.
 *
 * Falls back to the bare app name when none of the recognised primary
 * fields are present (e.g. user hasn't filled them yet, or this is a new
 * app whose shape isn't listed below).
 */
function smartDefaultName(
  appKey: string,
  appName: string,
  values: FieldValues,
): string {
  const v = values ?? {};
  const trim = (raw: unknown): string =>
    typeof raw === "string" ? raw.trim() : "";

  switch (appKey) {
    case "google-sheets": {
      const sheet = trim(v.sheetName);
      if (sheet) return `Sheets · ${sheet}`;
      return appName;
    }
    case "telegram": {
      const chat = trim(v.chatId);
      if (chat) return `Telegram · ${chat}`;
      return appName;
    }
    case "plain-url": {
      const url = trim(v.url);
      if (url) {
        try {
          const host = new URL(url).hostname.replace(/^www\./, "");
          const method = trim(v.method) || "POST";
          return `${method} · ${host}`;
        } catch {
          // malformed URL — fall through to app name
        }
      }
      return appName;
    }
    default:
      return appName;
  }
}

/**
 * Translate dynamic-form values into a `destinations.update` payload. Returns
 * `null` for app types whose templateConfig fields aren't first-class on the
 * update procedure (http-api-key, http-request) — the caller surfaces a
 * graceful "not supported here yet" message.
 *
 * Locked fields (appKey, connectionId) are deliberately omitted — the server
 * preserves what it isn't told to change, so omission == lock.
 */
function buildUpdatePayload(
  appKey: string,
  id: number,
  name: string,
  v: FieldValues,
): Record<string, unknown> | null {
  if (appKey === "telegram") {
    const chatId =
      typeof v.chatId === "string" ? v.chatId.trim() : undefined;
    const messageTemplate =
      typeof v.messageTemplate === "string" ? v.messageTemplate : undefined;
    return {
      id,
      name,
      ...(chatId !== undefined ? { chatId } : {}),
      ...(messageTemplate !== undefined ? { messageTemplate } : {}),
    };
  }
  if (appKey === "google-sheets") {
    const spreadsheetId =
      typeof v.spreadsheetId === "string" ? v.spreadsheetId.trim() : undefined;
    const sheetName =
      typeof v.sheetName === "string" ? v.sheetName.trim() : undefined;
    const mapping =
      v.mapping && typeof v.mapping === "object"
        ? (v.mapping as Record<string, string>)
        : undefined;
    return {
      id,
      name,
      ...(spreadsheetId !== undefined ? { spreadsheetId } : {}),
      ...(sheetName !== undefined ? { sheetName } : {}),
      ...(mapping !== undefined
        ? { mapping, sheetHeaders: Object.keys(mapping) }
        : {}),
    };
  }
  // http-api-key / http-request / others: the server's `destinations.update`
  // procedure doesn't currently write arbitrary `templateConfig` overrides
  // back to the row, so we can't safely round-trip these. Returning null
  // tells the caller to bail with a graceful notice.
  return null;
}

function prettyCategory(cat: string): string {
  switch (cat) {
    case "messaging":
      return "Messaging";
    case "spreadsheet":
      return "Spreadsheets";
    case "webhook":
      return "Webhooks";
    case "ecommerce":
      return "E-commerce / Affiliate";
    case "affiliate":
      return "Affiliate";
    default:
      return cat.charAt(0).toUpperCase() + cat.slice(1);
  }
}

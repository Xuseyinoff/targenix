/**
 * IntegrationWizardV2 — Make.com-style stacked-card wizard for creating a
 * LEAD_ROUTING integration.
 *
 * Mounted at /integrations/new-v2 and /integrations/edit-v2/:id.
 * Old URLs `/integrations/new-routing` and `/integrations/edit-routing/:id`
 * redirect here (see App.tsx).
 *
 * The wizard persists two surfaces on each save:
 *   1. Top-level dedicated fields (preferred by the server for the matching
 *      columns): pageId, formId, pageName, formName, facebookAccountId,
 *      destinationId.
 *   2. integration.config JSON — fields that don't have dedicated columns:
 *      { fieldMappings, nameField, phoneField, targetWebsiteName,
 *        targetTemplateType, variableFields }
 *   The 6 dedicated keys are intentionally NOT echoed inside config, so the
 *   JSON stays free of duplicates and there is a single source of truth.
 *
 * 5b scope (this commit):
 *   - Trigger card: Facebook account / page / form
 *   - Destination card: pick an EXISTING destination (grouped by category)
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
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  ChevronRight,
  Facebook,
  Loader2,
  Plus,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";
import {
  NAME_PATTERNS,
  PHONE_PATTERNS,
  autoMatchField,
  serializeFieldMappings,
  type FieldMapping,
} from "./lead-routing/shared";
import { DestinationCreatorInline } from "@/components/destinations/DestinationCreatorInline";
import { AppCatalogPicker } from "@/components/appCatalog/AppCatalogPicker";
import { resolveDestManifest } from "./lead-routing/resolveDestManifest";
import {
  INITIAL_STATE,
  type DestinationEntry,
  type WizardState,
} from "./lead-routing/wizardTypes";
import {
  CATEGORY_META,
  iconForCategory,
  type DestinationCategory,
} from "./lead-routing/categoryMeta";
import { LoadingBar } from "@/components/wizard/wizardPrimitives";
import { ZapperStep } from "@/components/wizard/ZapperStep";
import { TriggerEditor } from "@/components/wizard/TriggerEditor";
import { DestinationEditor } from "@/components/wizard/DestinationEditor";
import { AppManifestMapper } from "@/components/wizard/AppManifestMapper";

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

  const { data: destinations, isLoading: loadingTargets } =
    trpc.destinations.list.useQuery(undefined);

  const { data: appManifests = [] } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  // Derived: primary destination (first in the list) drives field mapping.
  const primaryDest: DestinationEntry | null = state.destinations[0] ?? null;
  const primaryDestId = primaryDest?.id ?? null;
  const primaryDestName = primaryDest?.name ?? "";
  const primaryDestType = primaryDest?.templateType ?? "";

  const { data: customVarNames = [] } =
    trpc.destinations.getCustomVariables.useQuery(
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
    if (!editIntegration || !destinations) return;

    const cfg = editIntegration.config as Record<string, unknown>;
    const savedDestIds = (editIntegration as unknown as { destinationIds?: number[] }).destinationIds;
    const destIds: number[] =
      savedDestIds && savedDestIds.length > 0
        ? savedDestIds
        : cfg.destinationId
          ? [Number(cfg.destinationId)]
          : [];

    const primaryTw = destinations.find((t) => t.id === destIds[0]);
    const primaryType = primaryTw?.appKey ?? (cfg.targetTemplateType as string) ?? "custom";
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

    const destEntries: DestinationEntry[] = destIds.map((id, idx) => {
      const tw = destinations.find((t) => t.id === id);
      return {
        id,
        name: tw?.name ?? (idx === 0 ? (cfg.targetWebsiteName as string) ?? "" : ""),
        templateType: tw?.appKey ?? (idx === 0 ? primaryType : "custom"),
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
      destinations: destEntries,
      integrationName: editIntegration.name,
      integrationNameTouched: true,
    });
    setActiveStep(2);
    setStateInitialized(true);
  }, [isEditMode, editIntegration, destinations, stateInitialized]);

  // ─── Auto-populate per-destination leadFields when form fields load ─────────
  // Runs after the FB form fields arrive (or the destination list updates with
  // fresh template metadata) and backfills two things:
  //   1. FROM_LEAD matches for mode="auto" fields (name / phone heuristics)
  //   2. Admin defaults for mode="static" fields (offer_id, stream, …) so
  //      when a user picks an existing destination they immediately see what
  //      will be sent instead of an empty box.
  // Existing user edits are never overwritten — we only fill EMPTY keys.
  useEffect(() => {
    if (!formFields?.length && !destinations?.length) return;
    setState((s) => {
      const updated = s.destinations.map((d) => {
        const destRecord = destinations?.find((t) => t.id === d.id);
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
  }, [formFields, destinations]);

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
      const destRecord = destinations?.find((t) => t.id === dest.id);
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
  }, [destinationFilled, state.destinations, destinations]);
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
    const destRecord = destinations?.find((t) => t.id === id);
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

    // Dedicated-column fields are passed at top level — server prefers them
    // over the matching keys inside `config`. We deliberately stop embedding
    // pageId / formId / pageName / formName / facebookAccountId / destinationId
    // inside the JSON to keep the source of truth in one place. `targetWebsiteName`
    // and `targetTemplateType` stay in `config` until their display fallbacks
    // are migrated off the JSON.
    const config = {
      fieldMappings,
      nameField: nameMapping?.from ?? "",
      phoneField: phoneMapping?.from ?? "",
      targetWebsiteName: primaryDestName,
      targetTemplateType: primaryDestType,
      variableFields,
    };
    const destinationIds = state.destinations.map((d) => d.id);
    const dedicatedFields = {
      pageId: state.pageId || undefined,
      formId: state.formId || undefined,
      pageName: state.pageName || undefined,
      formName: state.formName || undefined,
      facebookAccountId: state.accountId || undefined,
      destinationId: primaryDestId || undefined,
    };
    try {
      if (isEditMode) {
        await updateMutation.mutateAsync({
          id: editId!,
          name: state.integrationName.trim(),
          config,
          destinationIds,
          ...dedicatedFields,
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
          ...dedicatedFields,
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
    () => destinations?.find((t) => t.id === primaryDestId) ?? null,
    [destinations, primaryDestId],
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
        destinations?.find((t) => t.id === primaryDestId)?.category ?? "",
      )
    : Zap;
  const step2IconColor = destinationFilled
    ? (
        CATEGORY_META[
          (destinations?.find((t) => t.id === primaryDestId)
            ?.category ?? "") as DestinationCategory
        ]?.colorClass ?? "text-muted-foreground"
      )
        .split(" ")
        .find((c) => c.startsWith("text-")) ?? "text-primary"
    : "text-muted-foreground";

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      {/* ── Sticky page header (Wapi pattern) ── */}
      <div className="sticky top-16 z-30 -mx-6 -mt-6 mb-6 bg-background/85 backdrop-blur-md border-b border-slate-200/70 dark:border-border">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <button
            type="button"
            onClick={() => navigate("/integrations")}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Integrations
            <ChevronRight className="h-3 w-3 opacity-50" />
            <span>{isEditMode ? "Edit integration" : "New integration"}</span>
          </button>
          <h1 className="text-2xl font-bold tracking-tight text-primary mt-1">
            {isEditMode ? (editIntegration?.name ?? "Edit integration") : "New integration"}
          </h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto pb-16">
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
              <div className="flex justify-end pt-4 mt-2 border-t border-slate-200/70 dark:border-border">
                <Button
                  onClick={() => setActiveStep(2)}
                  className="wapi-button-hover rounded-full h-10 px-5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
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
                    destinations={destinations ?? []}
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
                    <div className="flex items-center justify-between pt-1 gap-3 flex-wrap">
                      <p className="text-xs text-muted-foreground">
                        {canSave
                          ? isEditMode
                            ? "Ready to save changes."
                            : "Ready to publish — activates immediately."
                          : "Fill in Name and Phone fields to continue."}
                      </p>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="ghost"
                          onClick={() => navigate("/integrations")}
                          disabled={isSaving}
                          className="wapi-button-hover rounded-full h-10 px-4 font-medium"
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleSave}
                          disabled={!canSave || isSaving}
                          className="wapi-button-hover rounded-full h-10 px-5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
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
      <AppCatalogPicker
        open={actionPickerOpen}
        onOpenChange={setActionPickerOpen}
        mode="destination"
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

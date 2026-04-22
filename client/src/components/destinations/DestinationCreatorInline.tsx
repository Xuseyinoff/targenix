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
import type { ConfigField } from "@/components/dynamic-form";
import { AppIcon, appIconBgClass } from "./appIcons";
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
  onCreated: (result: {
    id: number;
    name: string;
    templateType: string;
    category: string;
  }) => void;
  /** Called when the user clicks "Cancel" or "← Back" from the pick step. */
  onCancel: () => void;
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
  onCreated,
  onCancel,
}: DestinationCreatorInlineProps) {
  const [step, setStep] = React.useState<"pick" | "configure">(
    initialAppKey ? "configure" : "pick",
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
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [pendingAppKey, setPendingAppKey] = React.useState<string | null>(
    initialAppKey ?? null,
  );

  const utils = trpc.useUtils();
  const { data: apps = [], isLoading: loadingApps } =
    trpc.apps.list.useQuery();

  const createMutation = trpc.targetWebsites.create.useMutation();

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
    setNameError(null);
    setStep("configure");
    setPendingAppKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAppKey, loadingApps, supportedApps]);

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
    setNameError(null);
    setStep("configure");
  };

  const handleBack = () => {
    setStep("pick");
    setSelectedApp(null);
    setFormValues({});
    setFormErrors({});
    setNameError(null);
  };

  const handleSave = async () => {
    if (!selectedApp) return;
    const fields = selectedApp.modules[0]?.fields ?? [];

    setNameError(null);
    setFormErrors({});

    if (!destName.trim()) {
      setNameError("Destination name is required.");
      return;
    }

    const { isValid, errors } = validateFields(fields, formValues);
    if (!isValid) {
      setFormErrors(errors);
      return;
    }

    let payload: Parameters<typeof createMutation.mutateAsync>[0];
    try {
      payload = buildCreatePayload(selectedApp.key, destName.trim(), formValues);
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
      await utils.targetWebsites.list.invalidate();
      toast.success(`Created "${result.name ?? destName.trim()}"`);
      const fallbackTemplateType = isSupportedAppKey(selectedApp.key)
        ? APP_KEY_TO_TEMPLATE_TYPE[selectedApp.key]
        : "custom";
      onCreated({
        id: result.id,
        name: result.name ?? destName.trim(),
        templateType: result.templateType ?? fallbackTemplateType,
        category: selectedApp.category,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save destination",
      );
    }
  };

  const isSaving = createMutation.isPending;

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
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                          appIconBgClass(app.category),
                        )}
                      >
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
  if (!selectedApp) return null;
  const fields = selectedApp.modules[0]?.fields ?? [];

  return (
    <div className="space-y-5">
      {/* Header with back button */}
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

      {/* App identity banner */}
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border bg-muted/20 p-3",
        )}
      >
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            appIconBgClass(selectedApp.category),
          )}
        >
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

      {/* Destination name */}
      <div className="space-y-1.5">
        <Label htmlFor="inline-dest-name" className="text-xs">
          Destination name
          <span className="text-destructive"> *</span>
        </Label>
        <Input
          id="inline-dest-name"
          value={destName}
          onChange={(e) => {
            setDestName(e.target.value);
            if (e.target.value.trim()) setNameError(null);
          }}
          placeholder={`My ${selectedApp.name}`}
          disabled={isSaving}
          maxLength={255}
        />
        <p className="text-[11px] text-muted-foreground">
          Shown on your dashboard and in integration cards.
        </p>
        {nameError && (
          <p className="text-xs text-destructive">{nameError}</p>
        )}
      </div>

      {/* Dynamic form fields.
          `availableVariables` wakes up the Make.com-style per-field Map
          toggle — when the manifest marks a field `mappable: true` we want
          the user to be able to drop a lead variable in with one click.
          The list is the canonical set of keys affiliateService's
          injectVariables() expands at delivery, so what users pick here is
          exactly what they'll receive at runtime. */}
      <DynamicForm
        fields={fields}
        appKey={selectedApp.key}
        values={formValues}
        onChange={setFormValues}
        errors={formErrors}
        disabled={isSaving}
        availableVariables={LEAD_VARIABLE_SUGGESTIONS}
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
          Save destination
        </Button>
      </div>
    </div>
  );
}

// ─── Lead variable catalogue ────────────────────────────────────────────────
//
// Keep this list in sync with affiliateService.injectVariables() — every key
// below MUST be expanded at delivery time, otherwise the Map toggle would
// let a user pick a variable that silently renders as "{{full_name}}" in
// the outbound request. Adding a new key here without wiring it server-side
// is the most likely way to regress this feature.
const LEAD_VARIABLE_SUGGESTIONS: Array<{ key: string; label: string }> = [
  { key: "full_name", label: "Full name" },
  { key: "phone_number", label: "Phone number" },
  { key: "email", label: "Email" },
  { key: "pageName", label: "Page name" },
  { key: "formName", label: "Form name" },
  { key: "leadgen_id", label: "Lead ID" },
  { key: "page_id", label: "Page ID" },
  { key: "form_id", label: "Form ID" },
  { key: "createdAt", label: "Lead created at" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * DestinationCreatorDrawer — Phase 4, Commit 5c.2.
 *
 * Inline destination creator that opens from inside the v2 integration wizard.
 * Flow:
 *   1. Pick an app (Telegram, Google Sheets, custom HTTP webhook — driven by
 *      the AppManifest registry via trpc.apps.list).
 *   2. Give the destination a name and fill in the manifest-driven dynamic
 *      form (connection picker, async selects, field mapping, …).
 *   3. On save we POST to trpc.targetWebsites.create (5c.1 made it return the
 *      inserted id) and call onCreated so the wizard can auto-select the new
 *      destination without re-navigating.
 *
 * Why a drawer, not /target-websites in a new tab?
 *   The old CTA yanked the user out of the wizard and asked them to "return
 *   when done" — that context switch is exactly what Make.com and Zapier
 *   avoid. Keeping everything in one surface preserves momentum and all
 *   the wizard state the user has already filled in.
 *
 * Scope (this commit):
 *   - Supports apps whose manifest declares module[0].fields: telegram,
 *     google-sheets, plain-url. These map cleanly to the existing
 *     targetWebsites.create contract — no server changes required.
 *   - Dynamic-template / admin-template apps are intentionally NOT listed
 *     here; they live in destination_templates and have their own save
 *     flow (createFromTemplate) which will get its own picker later.
 */

import * as React from "react";
import { Loader2, Search, X, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

export interface DestinationCreatorDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after the server successfully inserts the new destination. The
   * wizard uses this to auto-select the destination it just created.
   */
  onCreated: (result: {
    id: number;
    name: string;
    templateType: string;
    category: string;
  }) => void;
  /**
   * When provided the drawer skips the app-picker step and goes directly to
   * the configure step for this app key (e.g. "telegram", "google-sheets").
   * Applied once the app manifest has loaded — safe to set before apps load.
   */
  initialAppKey?: string;
}

/**
 * Subset of AppManifest fields returned by trpc.apps.list. Kept local so we
 * don't leak the full manifest type into the drawer's public API.
 */
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

export function DestinationCreatorDrawer({
  open,
  onOpenChange,
  onCreated,
  initialAppKey,
}: DestinationCreatorDrawerProps) {
  const [step, setStep] = React.useState<"pick" | "configure">("pick");
  const [selectedApp, setSelectedApp] = React.useState<AppListItem | null>(null);
  const [search, setSearch] = React.useState("");
  const [destName, setDestName] = React.useState("");
  const [formValues, setFormValues] = React.useState<FieldValues>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});
  const [nameError, setNameError] = React.useState<string | null>(null);
  // Held here until the app manifest loads; cleared once applied.
  const [pendingAppKey, setPendingAppKey] = React.useState<string | null>(null);

  const utils = trpc.useUtils();
  const { data: apps = [], isLoading: loadingApps } =
    trpc.apps.list.useQuery(undefined, { enabled: open });

  const createMutation = trpc.targetWebsites.create.useMutation();

  // Reset internal state whenever the drawer is closed.
  React.useEffect(() => {
    if (open) return;
    setStep("pick");
    setSelectedApp(null);
    setSearch("");
    setDestName("");
    setFormValues({});
    setFormErrors({});
    setNameError(null);
    setPendingAppKey(null);
  }, [open]);

  // When the drawer opens with an initialAppKey, queue it so we can apply it
  // once supportedApps has loaded (apps load asynchronously after open=true).
  React.useEffect(() => {
    if (!open || !initialAppKey) return;
    setPendingAppKey(initialAppKey);
  }, [open, initialAppKey]);

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

  // Once supportedApps loads, auto-advance to configure if we have a pending key.
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
      toast.error(err instanceof Error ? err.message : "Could not build payload");
      return;
    }

    try {
      const result = await createMutation.mutateAsync(payload);
      if (!result?.id) {
        // Should not happen after 5c.1 server change, but we don't want the
        // UX to silently swallow the create.
        toast.error("Destination created but no id returned — please refresh.");
        return;
      }
      // Invalidate destinations list so the wizard's list query refetches
      // and the new row is present before onCreated auto-selects it.
      await utils.targetWebsites.list.invalidate();
      toast.success(`Created destination "${result.name ?? destName.trim()}"`);
      const fallbackTemplateType = isSupportedAppKey(selectedApp.key)
        ? APP_KEY_TO_TEMPLATE_TYPE[selectedApp.key]
        : "custom";
      onCreated({
        id: result.id,
        name: result.name ?? destName.trim(),
        templateType: result.templateType ?? fallbackTemplateType,
        category: selectedApp.category,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save destination");
    }
  };

  const isSaving = createMutation.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl p-0 flex flex-col"
      >
        <SheetHeader className="px-5 py-4 border-b bg-background sticky top-0 z-10">
          <div className="flex items-center gap-2">
            {step === "configure" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 -ml-1"
                onClick={handleBack}
                disabled={isSaving}
                aria-label="Back to app picker"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-base">
                {step === "pick"
                  ? "Create destination"
                  : selectedApp?.name ?? "Configure"}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {step === "pick"
                  ? "Pick an app to set up a new destination for your leads."
                  : selectedApp?.description ??
                    "Fill in the details for this destination."}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {step === "pick" ? (
            <AppPicker
              groupedApps={groupedApps}
              loading={loadingApps}
              search={search}
              setSearch={setSearch}
              onPick={handlePickApp}
            />
          ) : selectedApp ? (
            <ConfigureStep
              app={selectedApp}
              destName={destName}
              setDestName={(v) => {
                setDestName(v);
                if (v.trim()) setNameError(null);
              }}
              nameError={nameError}
              values={formValues}
              onChange={setFormValues}
              errors={formErrors}
              disabled={isSaving}
            />
          ) : null}
        </div>

        {step === "configure" && selectedApp && (
          <SheetFooter className="px-5 py-3 border-t bg-background sticky bottom-0 gap-2 sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Save destination
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── AppPicker ────────────────────────────────────────────────────────────────

interface AppPickerProps {
  groupedApps: Array<[string, AppListItem[]]>;
  loading: boolean;
  search: string;
  setSearch: (v: string) => void;
  onPick: (app: AppListItem) => void;
}

function AppPicker({
  groupedApps,
  loading,
  search,
  setSearch,
  onPick,
}: AppPickerProps) {
  return (
    <div className="p-5 space-y-4">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search apps (Telegram, Sheets, webhook, …)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-9"
        />
        {search && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 h-7 w-7 text-muted-foreground"
            onClick={() => setSearch("")}
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : groupedApps.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No apps match "{search}".
        </p>
      ) : (
        groupedApps.map(([category, items]) => (
          <div key={category} className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {prettyCategory(category)}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((app) => (
                <button
                  key={app.key}
                  type="button"
                  onClick={() => onPick(app)}
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
        ))
      )}
    </div>
  );
}

// ─── ConfigureStep ───────────────────────────────────────────────────────────

interface ConfigureStepProps {
  app: AppListItem;
  destName: string;
  setDestName: (v: string) => void;
  nameError: string | null;
  values: FieldValues;
  onChange: (v: FieldValues) => void;
  errors: Record<string, string>;
  disabled: boolean;
}

function ConfigureStep({
  app,
  destName,
  setDestName,
  nameError,
  values,
  onChange,
  errors,
  disabled,
}: ConfigureStepProps) {
  const fields = app.modules[0]?.fields ?? [];

  return (
    <div className="p-5 space-y-5">
      <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            appIconBgClass(app.category),
          )}
        >
          <AppIcon name={app.icon ?? "Globe"} className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{app.name}</div>
          {app.description && (
            <div className="text-[11px] text-muted-foreground line-clamp-1">
              {app.description}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="destination-name" className="text-xs">
          Destination name
          <span className="text-destructive"> *</span>
        </Label>
        <Input
          id="destination-name"
          value={destName}
          onChange={(e) => setDestName(e.target.value)}
          placeholder={`My ${app.name}`}
          disabled={disabled}
          maxLength={255}
        />
        <p className="text-[11px] text-muted-foreground">
          Shown on your dashboard and in integration cards.
        </p>
        {nameError && (
          <p className="text-xs text-destructive">{nameError}</p>
        )}
      </div>

      <DynamicForm
        fields={fields}
        appKey={app.key}
        values={values}
        onChange={onChange}
        errors={errors}
        disabled={disabled}
      />
    </div>
  );
}

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

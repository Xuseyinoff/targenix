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

/**
 * Mapping from manifest `app.key` → the templateType expected by
 * targetWebsites.create. Apps not listed here are hidden from the picker.
 */
const APP_KEY_TO_TEMPLATE_TYPE: Record<
  string,
  "telegram" | "google-sheets" | "custom"
> = {
  telegram: "telegram",
  "google-sheets": "google-sheets",
  "plain-url": "custom",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function DestinationCreatorDrawer({
  open,
  onOpenChange,
  onCreated,
}: DestinationCreatorDrawerProps) {
  const [step, setStep] = React.useState<"pick" | "configure">("pick");
  const [selectedApp, setSelectedApp] = React.useState<AppListItem | null>(null);
  const [search, setSearch] = React.useState("");
  const [destName, setDestName] = React.useState("");
  const [formValues, setFormValues] = React.useState<FieldValues>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});
  const [nameError, setNameError] = React.useState<string | null>(null);

  const utils = trpc.useUtils();
  const { data: apps = [], isLoading: loadingApps } =
    trpc.apps.list.useQuery(undefined, { enabled: open });

  const createMutation = trpc.targetWebsites.create.useMutation();

  // Reset internal state whenever the drawer is closed so re-opening starts
  // fresh. We deliberately do it on close (not on open) so a failed save
  // keeps the user's filled-in values while the drawer stays open.
  React.useEffect(() => {
    if (open) return;
    setStep("pick");
    setSelectedApp(null);
    setSearch("");
    setDestName("");
    setFormValues({});
    setFormErrors({});
    setNameError(null);
  }, [open]);

  const supportedApps = React.useMemo(
    () =>
      apps.filter((a) => {
        if (a.availability === "deprecated") return false;
        if (!APP_KEY_TO_TEMPLATE_TYPE[a.key]) return false;
        const fields = a.modules[0]?.fields;
        return Array.isArray(fields) && fields.length > 0;
      }),
    [apps],
  );

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
      onCreated({
        id: result.id,
        name: result.name ?? destName.trim(),
        templateType: result.templateType ?? APP_KEY_TO_TEMPLATE_TYPE[selectedApp.key] ?? "custom",
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

// ─── Payload builder ─────────────────────────────────────────────────────────

type CreatePayload =
  | {
      name: string;
      templateType: "telegram";
      connectionId?: number;
      chatId?: string;
      messageTemplate?: string;
    }
  | {
      name: string;
      templateType: "google-sheets";
      connectionId?: number;
      googleAccountId?: number;
      spreadsheetId: string;
      sheetName: string;
      sheetHeaders?: string[];
      mapping?: Record<string, string>;
    }
  | {
      name: string;
      templateType: "custom";
      url: string;
      method?: "POST" | "GET";
      contentType?: "json" | "form" | "form-urlencoded" | "multipart";
      bodyTemplate?: string;
      headers?: Record<string, string>;
    };

function buildCreatePayload(
  appKey: string,
  name: string,
  v: FieldValues,
): CreatePayload {
  if (appKey === "telegram") {
    const connectionId = asNumber(v.connectionId);
    if (!connectionId) {
      throw new Error("Select a Telegram connection first.");
    }
    const chatId = asString(v.chatId).trim();
    const messageTemplate = asString(v.messageTemplate);
    return {
      name,
      templateType: "telegram",
      connectionId,
      ...(chatId ? { chatId } : {}),
      ...(messageTemplate ? { messageTemplate } : {}),
    };
  }

  if (appKey === "google-sheets") {
    const connectionId = asNumber(v.connectionId);
    if (!connectionId) {
      throw new Error("Select a Google account first.");
    }
    const spreadsheetId = asString(v.spreadsheetId).trim();
    const sheetName = asString(v.sheetName).trim();
    if (!spreadsheetId) throw new Error("Spreadsheet is required.");
    if (!sheetName) throw new Error("Sheet tab is required.");
    const mapping =
      v.mapping && typeof v.mapping === "object"
        ? (v.mapping as Record<string, string>)
        : {};
    return {
      name,
      templateType: "google-sheets",
      connectionId,
      spreadsheetId,
      sheetName,
      mapping,
      sheetHeaders: Object.keys(mapping),
    };
  }

  if (appKey === "plain-url") {
    const url = asString(v.url).trim();
    if (!url) throw new Error("URL is required.");
    const method = asString(v.method) === "GET" ? "GET" : "POST";
    const contentTypeRaw = asString(v.contentType);
    const contentType: "json" | "form-urlencoded" | "multipart" =
      contentTypeRaw === "form-urlencoded" || contentTypeRaw === "multipart"
        ? (contentTypeRaw as "form-urlencoded" | "multipart")
        : "json";
    const bodyTemplate = asString(v.bodyTemplate);
    const headers = parseHeadersJson(asString(v.headers));
    return {
      name,
      templateType: "custom",
      url,
      method,
      contentType,
      ...(bodyTemplate ? { bodyTemplate } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  throw new Error(`Unsupported app: ${appKey}`);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function parseHeadersJson(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Headers must be a JSON object.");
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed)) {
      if (typeof val !== "string") {
        throw new Error(`Header "${k}" must be a string.`);
      }
      out[k] = val;
    }
    return out;
  } catch (err) {
    throw new Error(
      err instanceof Error ? `Invalid headers JSON: ${err.message}` : "Invalid headers JSON.",
    );
  }
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

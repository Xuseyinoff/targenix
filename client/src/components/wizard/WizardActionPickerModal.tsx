/**
 * WizardActionPickerModal — Make.com / Zapier-style "Choose an action"
 * modal for the Integration wizard (mounted at /integrations/new-v2).
 *
 * Split from the /connections AppPickerModal because the two pickers do
 * very different things with a click:
 *
 *  /connections/AppPickerModal → creates a CONNECTION (credentials row)
 *  IntegrationWizard picker    → creates a DESTINATION and hands it back
 *                                to the wizard so the mapping grid opens
 *                                immediately.
 *
 * Layout (mirrors the Zapier screenshot the user approved):
 *   Left rail : Home / Apps / Messaging / Data / Webhooks / Affiliate / Custom
 *   Top row   : full-width search
 *   Body      : two columns
 *                 YOUR TOP APPS   — one row per existing api_key connection
 *                 POPULAR APPS    — manifest apps + admin templates without
 *                                   any api_key connection yet
 *
 * Click handling:
 *   TOP APPS row (always api_key connection, by design — see note below):
 *     → `trpc.targetWebsites.createFromConnection` → emits the fresh
 *       target_websites row back to the parent. One-click.
 *
 *   POPULAR APPS row (manifest — Sheets / Telegram / Custom HTTP):
 *     → `onPickManifestApp(appKey)` — wizard opens DestinationCreatorInline
 *       (the existing flow keeps its OAuth popup / bot form / webhook builder).
 *
 *   POPULAR APPS row (admin template — Sotuvchi / 100k / Inbaza / MyCPA):
 *     → ApiKeyConnectDialog layers above the modal asking for displayName +
 *       the secret fields from `template.userVisibleFields`. On success we
 *       immediately call `createFromConnection` so the user lands in the
 *       mapping grid in one hop — no detour through /connections.
 *
 * Telegram / Sheets existing connections are intentionally NOT shown in TOP
 * APPS (yet): creating those destinations still needs additional inputs
 * (chat id / spreadsheet + sheet), and the inline creator already handles
 * that end-to-end. Promoting them here would misleadingly suggest a
 * "one-click" flow that requires another dialog. Revisit once the inline
 * creator accepts a pre-seeded `connectionId`.
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { resolveAppIcon } from "@/components/destinations/appIcons";
import {
  ApiKeyConnectDialog,
  type ApiKeyTemplate,
} from "@/components/connections/ApiKeyConnectDialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Search,
  Home as HomeIcon,
  LayoutGrid,
  MessageSquare,
  Database,
  Webhook,
  Target,
  Plus,
  Loader2,
  KeyRound,
} from "lucide-react";

// ─── Category taxonomy ──────────────────────────────────────────────────────

type UiCategory = "affiliate" | "messaging" | "data" | "webhooks" | "crm";

const SIDEBAR: Array<{
  id: "home" | "apps" | UiCategory | "custom";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "home",      label: "Home",      icon: HomeIcon },
  { id: "apps",      label: "Apps",      icon: LayoutGrid },
  { id: "messaging", label: "Messaging", icon: MessageSquare },
  { id: "data",      label: "Data",      icon: Database },
  { id: "webhooks",  label: "Webhooks",  icon: Webhook },
  { id: "affiliate", label: "Affiliate", icon: Target },
  { id: "custom",    label: "Custom",    icon: Plus },
];

function normalizeManifestCategory(raw: string | null | undefined): UiCategory {
  switch (raw) {
    case "messaging":   return "messaging";
    case "spreadsheet": return "data";
    case "webhook":     return "webhooks";
    case "ecommerce":   return "affiliate";
    case "affiliate":   return "affiliate";
    default:            return "webhooks";
  }
}

function normalizeTemplateCategory(raw: string | null | undefined): UiCategory {
  switch (raw) {
    case "messaging": return "messaging";
    case "data":      return "data";
    case "webhooks":  return "webhooks";
    case "affiliate": return "affiliate";
    case "crm":       return "crm";
    default:          return "affiliate";
  }
}

// Hand-picked brand tints for manifest apps so the picker doesn't look like a
// sea of identical grey dots. Admin templates already carry a `.color` string.
const BRAND_COLOR: Record<string, string> = {
  "telegram":      "#229ED9",
  "google-sheets": "#0F9D58",
  "plain-url":     "#6B7280",
  "http-webhook":  "#6B7280",
};

// ─── Entry shape ────────────────────────────────────────────────────────────

/**
 * Top rows and popular rows share the same visual component, so they share
 * the same entry type.  The `kind` discriminator routes the click handler.
 */
type Entry =
  | {
      kind: "connection";
      id: string;
      name: string;
      subtitle: string;
      category: UiCategory;
      color: string;
      iconName: string | null;
      connectionId: number;
      templateId: number;
      templateName: string;
    }
  | {
      kind: "manifest";
      id: string;
      name: string;
      subtitle: string;
      category: UiCategory;
      color: string;
      iconName: string | null;
      appKey: string;
    }
  | {
      kind: "template";
      id: string;
      name: string;
      subtitle: string;
      category: UiCategory;
      color: string;
      iconName: string | null;
      templateId: number;
      templateName: string;
      userVisibleFields: string[];
    };

// ─── Component ──────────────────────────────────────────────────────────────

export interface WizardActionPickerModalProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Fires after a destination is ready — wizard adds it to its list. */
  onDestinationReady: (
    destinationId: number,
    name: string,
    /** Passed straight through to DestinationEntry.templateType. */
    templateType: string,
  ) => void;
  /**
   * Fires for manifest apps that still need an inline creator (Sheets /
   * Telegram / Custom HTTP). The wizard reopens its existing
   * DestinationCreatorInline pointed at this app key.
   */
  onPickManifestApp: (appKey: string) => void;
}

export function WizardActionPickerModal({
  open,
  onOpenChange,
  onDestinationReady,
  onPickManifestApp,
}: WizardActionPickerModalProps) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [activeNav, setActiveNav] =
    useState<(typeof SIDEBAR)[number]["id"]>("home");

  // API-key form layered above the picker. Stores the template the user
  // just clicked so the dialog can render its userVisibleFields without
  // another round-trip.
  const [apiKeyTemplate, setApiKeyTemplate] =
    useState<ApiKeyTemplate | null>(null);

  // Tracks which row is currently hitting the server so we can show a
  // per-row spinner without blocking the rest of the picker.
  const [busyRow, setBusyRow] = useState<string | null>(null);

  // Data ─────────────────────────────────────────────────────────────────
  const { data: apps = [] } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { data: templates = [] } = trpc.targetWebsites.getTemplates.useQuery(
    undefined,
    { staleTime: 5 * 60 * 1000, enabled: open },
  );
  const { data: connList = [] } = trpc.connections.list.useQuery(undefined, {
    staleTime: 30 * 1000,
    enabled: open,
  });

  const createFromConnection =
    trpc.targetWebsites.createFromConnection.useMutation();

  // Lookup: templateId → template metadata (icon / colour / name).
  const templateById = useMemo(() => {
    const m = new Map<
      number,
      { name: string; color: string; category: UiCategory; iconName: string | null }
    >();
    for (const t of templates) {
      const tpl = t as { category?: string };
      m.set(t.id, {
        name: t.name,
        color: t.color,
        category: normalizeTemplateCategory(tpl.category ?? null),
        iconName: null,
      });
    }
    return m;
  }, [templates]);

  // Build TOP APPS from the user's api_key connections. Each connection row
  // maps to exactly one entry, keyed by connectionId — so users with two
  // "Sotuvchi" keys see two clear rows, which matches the Make.com picker.
  const topEntries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const c of connList) {
      if (c.type !== "api_key" || !c.apiKey) continue;
      const tpl = templateById.get(c.apiKey.templateId);
      out.push({
        kind: "connection",
        id: `conn-${c.id}`,
        name: tpl?.name ?? c.apiKey.templateName,
        subtitle: c.displayName,
        category: tpl?.category ?? "affiliate",
        color: tpl?.color ?? c.apiKey.templateColor,
        iconName: tpl?.iconName ?? null,
        connectionId: c.id,
        templateId: c.apiKey.templateId,
        templateName: tpl?.name ?? c.apiKey.templateName,
      });
    }
    return out;
  }, [connList, templateById]);

  // Ids of templates already represented in TOP APPS — used to hide them
  // from POPULAR so users don't see "Sotuvchi" in both columns once they've
  // connected it. Destinations with multiple keys still surface each key
  // because the top iteration runs per connection.
  const templateIdsWithConnection = useMemo(() => {
    const s = new Set<number>();
    for (const c of connList) {
      if (c.type === "api_key" && c.apiKey) s.add(c.apiKey.templateId);
    }
    return s;
  }, [connList]);

  // Build POPULAR APPS = manifest apps (sheets/telegram/custom) + admin
  // templates the user has not yet connected. Custom HTTP webhook always
  // stays here (it's a degenerate "app" with no connection concept).
  const popularEntries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const a of apps) {
      // Hide internal meta-adapters (dynamic-template) — they only represent
      // the "admin template" generic entry and would confuse users who want
      // to pick a specific affiliate.
      if ((a as { internal?: boolean }).internal) continue;
      out.push({
        kind: "manifest",
        id: `app-${a.key}`,
        name: a.name,
        subtitle: shortDescription(a.description),
        category: normalizeManifestCategory(a.category),
        color: BRAND_COLOR[a.key] ?? "#3B82F6",
        iconName: a.icon,
        appKey: a.key,
      });
    }
    for (const t of templates) {
      if (templateIdsWithConnection.has(t.id)) continue;
      const tpl = t as {
        category?: string;
        userVisibleFields?: string[] | null;
      };
      out.push({
        kind: "template",
        id: `tpl-${t.id}`,
        name: t.name,
        subtitle: "Admin-managed affiliate",
        category: normalizeTemplateCategory(tpl.category ?? null),
        color: t.color,
        iconName: null,
        templateId: t.id,
        templateName: t.name,
        userVisibleFields: tpl.userVisibleFields ?? [],
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [apps, templates, templateIdsWithConnection]);

  // Apply sidebar + search filters over both columns together.
  const filterEntry = (e: Entry) => {
    if (activeNav === "custom") {
      if (e.kind !== "template") return false;
    } else if (activeNav !== "home" && activeNav !== "apps") {
      if (e.category !== activeNav) return false;
    }
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.subtitle.toLowerCase().includes(q)
    );
  };
  const topFiltered = useMemo(
    () => topEntries.filter(filterEntry),
    [topEntries, activeNav, search],
  );
  const popularFiltered = useMemo(
    () => popularEntries.filter(filterEntry),
    [popularEntries, activeNav, search],
  );

  // Click routing ─────────────────────────────────────────────────────────

  const useConnection = async (
    connectionId: number,
    rowId: string,
    nameHint: string,
  ) => {
    setBusyRow(rowId);
    try {
      const res = await createFromConnection.mutateAsync({ connectionId });
      // Refetch (not just invalidate) so the wizard's targetWebsites list has
      // the fresh row by the time addDestination() reads it — prevents a
      // frame where the mapping grid renders with an empty manifest.
      await utils.targetWebsites.list.refetch();
      onDestinationReady(res.id, res.name, "custom");
      onOpenChange(false);
      toast.success(`${nameHint} added`);
    } catch (err) {
      toast.error((err as Error).message || "Failed to add destination");
    } finally {
      setBusyRow(null);
    }
  };

  const handlePick = (entry: Entry) => {
    if (busyRow) return;

    if (entry.kind === "connection") {
      void useConnection(entry.connectionId, entry.id, entry.name);
      return;
    }

    if (entry.kind === "manifest") {
      onOpenChange(false);
      onPickManifestApp(entry.appKey);
      return;
    }

    // entry.kind === "template" — no connection yet; ask for api key inline.
    setApiKeyTemplate({
      id: entry.templateId,
      name: entry.name,
      userVisibleFields: entry.userVisibleFields,
      color: entry.color,
    });
  };

  // After ApiKeyConnectDialog persists a new connection we immediately fan
  // out to createFromConnection so the user only answers once to get a
  // usable destination in the wizard.
  const handleApiKeyCreated = async (
    connectionId: number,
    displayName: string,
  ) => {
    const tpl = apiKeyTemplate;
    setApiKeyTemplate(null);
    if (!tpl) return;
    setBusyRow(`tpl-${tpl.id}`);
    try {
      const res = await createFromConnection.mutateAsync({ connectionId });
      await utils.targetWebsites.list.refetch();
      await utils.connections.list.invalidate();
      onDestinationReady(res.id, res.name, "custom");
      onOpenChange(false);
      toast.success(`${displayName} added`);
    } catch (err) {
      toast.error((err as Error).message || "Failed to add destination");
    } finally {
      setBusyRow(null);
    }
  };

  // Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-w-4xl p-0 overflow-hidden gap-0",
          "sm:max-w-[900px]",
        )}
      >
        <div className="flex h-[560px] max-h-[80vh] w-full">
          {/* ── Left sidebar ────────────────────────────────────────────── */}
          <aside className="w-[180px] shrink-0 border-r border-border/70 bg-muted/30 p-2 space-y-0.5">
            {SIDEBAR.map((item) => {
              const Icon = item.icon;
              const active = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </aside>

          {/* ── Right content ───────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Search */}
            <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${apps.length + templates.length}+ apps and tools...`}
                  className="h-10 rounded-lg border-transparent bg-muted/40 pl-9 text-sm focus-visible:bg-background"
                />
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {topFiltered.length === 0 && popularFiltered.length === 0 ? (
                <EmptyState query={search} />
              ) : (
                <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                  <Column
                    title="Your top apps"
                    empty="No connections yet"
                    items={topFiltered}
                    onPick={handlePick}
                    busyRow={busyRow}
                  />
                  <Column
                    title="Popular apps"
                    empty="Nothing else in this category"
                    items={popularFiltered}
                    onPick={handlePick}
                    busyRow={busyRow}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      {/* Inline api-key form — layered above the picker thanks to Radix
          Dialog's z-stack. On success we jump straight to creating the
          destination so the user doesn't have to click "Done" twice. */}
      <ApiKeyConnectDialog
        open={apiKeyTemplate !== null}
        onOpenChange={(v) => !v && setApiKeyTemplate(null)}
        template={apiKeyTemplate}
        onCreated={handleApiKeyCreated}
      />
    </Dialog>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Column({
  title,
  empty,
  items,
  onPick,
  busyRow,
}: {
  title: string;
  empty: string;
  items: Entry[];
  onPick: (e: Entry) => void;
  busyRow: string | null;
}) {
  return (
    <div>
      <h3 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="px-2 py-6 text-xs text-muted-foreground/70">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((e) => (
            <li key={e.id}>
              <Row
                entry={e}
                onPick={onPick}
                busy={busyRow === e.id}
                disabled={busyRow !== null && busyRow !== e.id}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  entry,
  onPick,
  busy,
  disabled,
}: {
  entry: Entry;
  onPick: (e: Entry) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const Icon = resolveAppIcon(entry.iconName);
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => onPick(entry)}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
        "hover:bg-muted/50 active:bg-muted/70",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `${entry.color}1A`, color: entry.color }}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : entry.kind === "connection" ? (
          <KeyRound className="h-4 w-4" strokeWidth={2.2} />
        ) : (
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {entry.name}
        </span>
        {entry.subtitle && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {entry.subtitle}
          </span>
        )}
      </span>
      {busy && (
        <span className="ml-auto text-xs text-muted-foreground">Adding…</span>
      )}
    </button>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
        <Search className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">
        {query ? `No apps match “${query}”` : "No apps here yet"}
      </p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        Try another category, or ask an admin to add a new destination template.
      </p>
    </div>
  );
}

function shortDescription(
  raw: string | null | undefined,
  max: number = 38,
): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

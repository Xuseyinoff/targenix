/**
 * AppPickerModal — Zapier "Add app" replica for /connections.
 *
 * Layout mirrors Zapier's picker 1:1:
 *   • Left rail: category shortcuts (Home, Apps, Messaging, Data, Webhooks,
 *     Affiliate, Custom). Clicking filters the right pane.
 *   • Top of right pane: full-width search + "Browse all" escape hatch.
 *   • Body: two columns — "Your top apps" (apps with ≥1 existing connection)
 *     and "Popular apps" (everything else, alphabetical). Each row is a
 *     brand-coloured icon tile + app name, nothing else — same visual density
 *     as the Zapier screenshot the user referenced.
 *
 * Data sources:
 *   • `trpc.apps.list` — code-registered manifests (Telegram, Sheets, HTTP)
 *   • `trpc.targetWebsites.getTemplates` — admin-managed UZ-CPA affiliates
 *   • `trpc.targetWebsites.list` — used only to derive the "top apps" bucket
 *
 * Click behaviour (intentionally non-destructive for this iteration):
 *   • manifest apps Google/Telegram → close modal, scroll to their section
 *     on the same page (those sections already own their OAuth flow)
 *   • admin templates → navigate to /destinations?template=<id>, which has
 *     the create-from-template dialog wired in phase 2B
 *   • any other manifest app (http-webhook, future) → /destinations?type=<k>
 * A unified inline create-form lives in phase 2C2 and is out of scope here.
 */

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { resolveAppIcon } from "@/components/destinations/appIcons";
import { TelegramConnectDialog } from "@/components/connections/TelegramConnectDialog";
import {
  ApiKeyConnectDialog,
  type ApiKeyTemplate,
} from "@/components/connections/ApiKeyConnectDialog";
import { useGoogleOAuthPopup } from "@/hooks/useGoogleOAuthPopup";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/hooks/useT";
import {
  Search,
  Home as HomeIcon,
  LayoutGrid,
  MessageSquare,
  Database,
  Webhook,
  Target,
  Plus,
  ExternalLink,
  Loader2,
} from "lucide-react";

// ─── Category taxonomy ───────────────────────────────────────────────────────
// We keep the UI labels stable and map both `server AppCategory` and the
// destination_templates enum into these buckets.

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
  "http-webhook":  "#6B7280",
};

// ─── Unified card shape ──────────────────────────────────────────────────────

interface AppEntry {
  id: string;
  name: string;
  category: UiCategory;
  iconName: string | null;
  color: string;
  source: "manifest" | "template";
  templateId: number | null;
  destTypeKey: string | number;
  /** Present for admin-template entries — drives the ApiKeyConnectDialog. */
  userVisibleFields: string[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AppPickerModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [, setLocation] = useLocation();
  const t = useT();
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [activeNav, setActiveNav] =
    useState<(typeof SIDEBAR)[number]["id"]>("home");

  // Telegram bot creation form — opened when the user picks the Telegram card.
  // Kept inside this modal so closing the picker cascades to closing the form.
  const [telegramOpen, setTelegramOpen] = useState(false);

  // API-key creation form — opened when the user picks an admin template.
  // Stores the full template row so the dialog can render its userVisibleFields
  // without re-querying.
  const [apiKeyTemplate, setApiKeyTemplate] =
    useState<ApiKeyTemplate | null>(null);

  // Google Sheets creation piggy-backs on the shared OAuth hook; firing the
  // popup from here means we don't need a standalone "Google connect" page.
  const { start: startGoogleOAuth, isConnecting: isGoogleConnecting } =
    useGoogleOAuthPopup({
      onConnected: (_accountId, email) => {
        toast.success(
          email
            ? t("connections.google.connectedWithEmail", { email })
            : t("connections.google.connected"),
        );
        utils.connections.list.invalidate();
      },
      onError: (message) => {
        toast.error(message || t("connections.google.connectFailed"));
      },
    });

  const { data: apps = [] } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { data: templates = [] } = trpc.targetWebsites.getTemplates.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { data: existingDests = [] } = trpc.targetWebsites.list.useQuery(undefined, {
    staleTime: 60 * 1000,
    enabled: open,
  });

  // Build the unified entry list once.
  const entries = useMemo<AppEntry[]>(() => {
    const out: AppEntry[] = [];
    for (const a of apps) {
      out.push({
        id: `app-${a.key}`,
        name: a.name,
        category: normalizeManifestCategory(a.category),
        iconName: a.icon,
        color: BRAND_COLOR[a.key] ?? "#3B82F6",
        source: "manifest",
        templateId: null,
        destTypeKey: a.key,
        userVisibleFields: [],
      });
    }
    for (const t of templates) {
      const tpl = t as {
        category?: string;
        userVisibleFields?: string[] | null;
      };
      out.push({
        id: `tpl-${t.id}`,
        name: t.name,
        category: normalizeTemplateCategory(tpl.category ?? null),
        iconName: null,
        color: t.color,
        source: "template",
        templateId: t.id,
        destTypeKey: t.id,
        userVisibleFields: tpl.userVisibleFields ?? [],
      });
    }
    return out;
  }, [apps, templates]);

  // Which entries already have at least one connection — drives "Your top apps".
  const usageCount = useMemo(() => {
    const m = new Map<string | number, number>();
    for (const d of existingDests) {
      const key: string | number = d.templateId ?? d.templateType ?? "custom";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [existingDests]);

  // Apply sidebar + search filters.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (activeNav === "custom") {
        if (e.source !== "template") return false;
      } else if (activeNav !== "home" && activeNav !== "apps") {
        if (e.category !== activeNav) return false;
      }
      if (!q) return true;
      return e.name.toLowerCase().includes(q);
    });
  }, [entries, activeNav, search]);

  // Split into "top" (has connections) vs "popular" (doesn't) — Zapier layout.
  const { topApps, popularApps } = useMemo(() => {
    const top: AppEntry[] = [];
    const pop: AppEntry[] = [];
    for (const e of filtered) {
      (usageCount.get(e.destTypeKey) ?? 0) > 0 ? top.push(e) : pop.push(e);
    }
    top.sort(
      (a, b) =>
        (usageCount.get(b.destTypeKey) ?? 0) -
        (usageCount.get(a.destTypeKey) ?? 0),
    );
    pop.sort((a, b) => a.name.localeCompare(b.name));
    return { topApps: top, popularApps: pop };
  }, [filtered, usageCount]);

  const handlePick = (entry: AppEntry) => {
    // Admin-managed template (Sotuvchi, 100k, Inbaza, MyCPA…) — open the
    // inline ApiKeyConnectDialog. The form itself reads userVisibleFields
    // from the entry we just built, so adding a new affiliate never touches
    // this file.
    if (entry.source === "template" && entry.templateId != null) {
      setApiKeyTemplate({
        id: entry.templateId,
        name: entry.name,
        userVisibleFields: entry.userVisibleFields,
        color: entry.color,
      });
      return;
    }

    // Built-in manifest apps: keep the picker open until the user completes
    // the credential step (OAuth popup / bot form). Closing the picker on
    // click would leave the user staring at a blank /connections page while
    // the popup loads — worse UX than holding the modal for one more beat.
    if (entry.source === "manifest") {
      if (entry.destTypeKey === "google-sheets") {
        void startGoogleOAuth();
        return;
      }

      if (entry.destTypeKey === "telegram") {
        setTelegramOpen(true);
        return;
      }

      // http-webhook and any future manifest app without an in-modal flow
      // fall back to the existing /destinations creation path.
      onOpenChange(false);
      setLocation(`/destinations?type=${entry.destTypeKey}`);
    }
  };

  // Indicates which specific app row is currently in a busy state (OAuth
  // popup open, etc.) so the row can render a spinner without blocking the
  // rest of the picker.
  const busyKey: string | number | null = isGoogleConnecting
    ? "google-sheets"
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-w-4xl p-0 overflow-hidden gap-0",
          // Kill the default horizontal padding so the sidebar hugs the edge.
          "sm:max-w-[900px]",
        )}
      >
        <div className="flex h-[560px] max-h-[80vh] w-full">
          {/* ── Left sidebar ───────────────────────────────────────────── */}
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

          {/* ── Right content ──────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Search */}
            <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${entries.length}+ apps and tools...`}
                  className="h-10 rounded-lg border-transparent bg-muted/40 pl-9 text-sm focus-visible:bg-background"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  setLocation("/destinations");
                }}
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
              >
                Browse all
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {topApps.length === 0 && popularApps.length === 0 ? (
                <EmptyState query={search} />
              ) : (
                <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                  <Column
                    title="Your top apps"
                    empty="No apps connected yet"
                    items={topApps}
                    onPick={handlePick}
                    busyKey={busyKey}
                  />
                  <Column
                    title="Popular apps"
                    empty="Nothing else in this category"
                    items={popularApps}
                    onPick={handlePick}
                    busyKey={busyKey}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      {/* Telegram bot form — separate Dialog so it can layer above the picker.
          On success we close both so the user lands back on /connections with
          their new row visible. */}
      <TelegramConnectDialog
        open={telegramOpen}
        onOpenChange={setTelegramOpen}
        onCreated={() => {
          setTelegramOpen(false);
          onOpenChange(false);
        }}
      />

      {/* Admin template API-key form — rendered purely from the template's
          userVisibleFields, so 4 affiliates today and 400 tomorrow share the
          exact same component. Success closes both the dialog and the picker
          so the user lands on /connections with their new row visible. */}
      <ApiKeyConnectDialog
        open={apiKeyTemplate !== null}
        onOpenChange={(v) => !v && setApiKeyTemplate(null)}
        template={apiKeyTemplate}
        onCreated={() => {
          setApiKeyTemplate(null);
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Column({
  title,
  empty,
  items,
  onPick,
  busyKey,
}: {
  title: string;
  empty: string;
  items: AppEntry[];
  onPick: (e: AppEntry) => void;
  busyKey: string | number | null;
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
              <AppRow
                entry={e}
                onPick={onPick}
                busy={busyKey === e.destTypeKey}
                disabled={busyKey !== null && busyKey !== e.destTypeKey}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AppRow({
  entry,
  onPick,
  busy,
  disabled,
}: {
  entry: AppEntry;
  onPick: (e: AppEntry) => void;
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
        ) : (
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        )}
      </span>
      <span className="truncate text-sm font-medium text-foreground">
        {entry.name}
      </span>
      {busy && (
        <span className="ml-auto text-xs text-muted-foreground">Connecting…</span>
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

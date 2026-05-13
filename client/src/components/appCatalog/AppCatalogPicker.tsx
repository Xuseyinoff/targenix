/**
 * AppCatalogPicker — the one picker to rule them all.
 *
 * Replaces the previously-duplicated AppPickerModal (/connections) and
 * WizardActionPickerModal (/integrations wizard). Both pages opened a
 * Zapier-style picker, both showed the same apps in the same layout, and
 * the only real difference was what happened after click:
 *
 *   mode="connection"   → save credential, fire onConnectionCreated, close
 *   mode="destination"  → save credential, create destination, fire
 *                          onDestinationReady, close
 *
 * Sharing the picker also means the catalog metadata (descriptions,
 * popular ribbon, auth badges) lives in one place — lib/appCatalog.ts — so a
 * change there propagates to every call site automatically.
 *
 * The behaviour matrix below mirrors the original two pickers 1:1:
 *
 *  ┌──────────────────────┬─────────────────────────────────┬──────────────────────────────┐
 *  │ Row type             │ connection mode click           │ destination mode click       │
 *  ├──────────────────────┼─────────────────────────────────┼──────────────────────────────┤
 *  │ existing connection  │ (hidden — pick another app)     │ createFromConnection → ready │
 *  │ manifest telegram    │ TelegramConnectDialog (inline)  │ onPickManifestApp("telegram")│
 *  │ manifest google      │ Google OAuth popup (inline)     │ onPickManifestApp("google-…")│
 *  │ manifest oauth2 app  │ Generic OAuth2 popup (inline)   │ onPickManifestApp(appKey)    │
 *  │ manifest http/other  │ /destinations?type=appKey        │ onPickManifestApp(appKey)    │
 *  │ template (CPA api)   │ ApiKeyConnectDialog (inline)    │ ApiKey → createFromConnection│
 *  └──────────────────────┴─────────────────────────────────┴──────────────────────────────┘
 */

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AppIcon, appBrandIconTileClass } from "@/components/destinations/appIcons";
import { iconUrlForTemplateAppKey } from "@shared/affiliateBrandDomains";
import { TelegramConnectDialog } from "@/components/connections/TelegramConnectDialog";
import {
  ApiKeyConnectDialog,
  type ApiKeyTemplate,
} from "@/components/connections/ApiKeyConnectDialog";
import { useGoogleOAuthPopup } from "@/hooks/useGoogleOAuthPopup";
import { useOAuth2Popup } from "@/hooks/useOAuth2Popup";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Search,
  Plus,
  Loader2,
  Sparkles,
  KeyRound,
} from "lucide-react";
import {
  SIDEBAR,
  type SidebarId,
  type UiCategory,
  BRAND_COLOR,
  normalizeManifestCategory,
  normalizeTemplateCategory,
  descriptionFor,
  isPopular,
  authBadgeFor,
  shortDescription,
} from "@/lib/appCatalog";

// ─── Public API ──────────────────────────────────────────────────────────────

export type AppCatalogMode = "connection" | "destination";

export interface AppCatalogPickerProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: AppCatalogMode;

  /** Destination mode: fires after a destination is wired up and ready. */
  onDestinationReady?: (
    destinationId: number,
    name: string,
    templateType: string,
  ) => void;
  /** Destination mode: for manifest apps that still need the inline creator
   *  (Sheets / Telegram / Custom HTTP). The wizard reopens DestinationCreatorInline
   *  pointed at this app key. */
  onPickManifestApp?: (appKey: string) => void;

  /** Connection mode: fires when a credential is saved. Optional — modal closes
   *  itself regardless and connections.list is invalidated. */
  onConnectionCreated?: (connectionId: number, displayName: string) => void;
}

// ─── Internal entry shape ────────────────────────────────────────────────────

type Entry =
  | {
      kind: "existingConnection";
      id: string;
      name: string;
      subtitle: string;
      category: UiCategory;
      color: string;
      iconName: string | null;
      connectionId: number;
      templateId: number;
      templateName: string;
      description: string;
      popular: boolean;
      authType: string | null;
      connectionType: string | null;
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
      description: string;
      popular: boolean;
      authType: string | null;
      connectionType: string | null;
      /**
       * Manifest availability flag — `"beta"` surfaces a badge so users know
       * the integration is not stable yet. `"deprecated"` is filtered out
       * upstream so we never have to render anything for it here.
       */
      availability?: "stable" | "beta" | "deprecated";
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
      description: string;
      popular: boolean;
      authType: string | null;
      connectionType: string | null;
    };

// ─── Component ───────────────────────────────────────────────────────────────

export function AppCatalogPicker({
  open,
  onOpenChange,
  mode,
  onDestinationReady,
  onPickManifestApp,
  onConnectionCreated,
}: AppCatalogPickerProps) {
  const [, setLocation] = useLocation();
  const t = useT();
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [activeNav, setActiveNav] = useState<SidebarId>("home");

  // Auxiliary dialogs / popups layered above the picker.
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [apiKeyTemplate, setApiKeyTemplate] = useState<ApiKeyTemplate | null>(null);
  const [oauth2BusyAppKey, setOauth2BusyAppKey] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  // Google OAuth — only fires from connection mode. In destination mode the
  // wizard's inline creator owns the popup so we just hand off the app key.
  const { start: startGoogleOAuth, isConnecting: isGoogleConnecting } =
    useGoogleOAuthPopup({
      onConnected: (_accountId, email) => {
        toast.success(
          email
            ? t("connections.google.connectedWithEmail", { email })
            : t("connections.google.connected"),
        );
        utils.connections.list.invalidate();
        if (mode === "connection") {
          onConnectionCreated?.(_accountId, email ?? "Google account");
          onOpenChange(false);
        }
      },
      onError: (message) => {
        toast.error(message || t("connections.google.connectFailed"));
      },
    });

  // Generic OAuth2 (Kommo, Pipedrive, etc.) — same pattern as Google.
  const { start: startOAuth2, isConnecting: isOAuth2Connecting } = useOAuth2Popup({
    appKey: oauth2BusyAppKey ?? "",
    onConnected: (connectionId, email, displayName) => {
      toast.success(displayName ? `Connected: ${displayName}` : `Connected: ${email}`);
      utils.connections.list.invalidate();
      setOauth2BusyAppKey(null);
      if (mode === "connection" && connectionId != null) {
        onConnectionCreated?.(connectionId, displayName ?? email ?? "Connected");
      }
      onOpenChange(false);
    },
    onError: (message) => {
      toast.error(message || "OAuth connect failed");
      setOauth2BusyAppKey(null);
    },
  });

  // Data ─────────────────────────────────────────────────────────────────────
  const { data: apps = [] } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { data: appKeyOptions = [] } = trpc.connections.listAppKeys.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { data: templates = [] } = trpc.destinations.getTemplates.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const { data: connList = [] } = trpc.connections.list.useQuery(undefined, {
    staleTime: 30 * 1000,
    enabled: open,
  });

  const createFromConnection = trpc.destinations.createFromConnection.useMutation();

  // Lookup tables ────────────────────────────────────────────────────────────

  const authByKey = useMemo(
    () => new Map(appKeyOptions.map((a) => [a.appKey, a.authType])),
    [appKeyOptions],
  );

  const templateById = useMemo(() => {
    const m = new Map<
      number,
      { name: string; color: string; category: UiCategory; iconName: string | null }
    >();
    for (const tt of templates) {
      const tpl = tt as { category?: string; appKey?: string | null; appIconUrl?: string | null };
      m.set(tt.id, {
        name: tt.name,
        color: tt.color,
        category: normalizeTemplateCategory(tpl.category ?? null),
        iconName: iconUrlForTemplateAppKey(tpl.appKey ?? null, tpl.appIconUrl ?? null),
      });
    }
    return m;
  }, [templates]);

  // Connection-count per template — drives the "X saved · add another" hint
  // shown on template rows in destination mode.
  const connectionCountByTemplate = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of connList) {
      if (c.type === "api_key" && c.apiKey) {
        m.set(c.apiKey.templateId, (m.get(c.apiKey.templateId) ?? 0) + 1);
      }
    }
    return m;
  }, [connList]);

  // Sections ─────────────────────────────────────────────────────────────────

  // Existing api_key connections — only surfaced in destination mode for
  // one-click reuse. Connection mode hides this because the user is here to
  // ADD, not pick; promoting reuse would lead them to a no-op click.
  const topEntries = useMemo<Entry[]>(() => {
    if (mode !== "destination") return [];
    const out: Entry[] = [];
    for (const c of connList) {
      if (c.type !== "api_key" || !c.apiKey) continue;
      const tpl = templateById.get(c.apiKey.templateId);
      const appKey = c.apiKey.templateAppKey ?? c.apiKey.templateName;
      const category = tpl?.category ?? "affiliate";
      out.push({
        kind: "existingConnection",
        id: `conn-${c.id}`,
        name: tpl?.name ?? c.apiKey.templateName,
        subtitle: c.displayName,
        category,
        color: tpl?.color ?? c.apiKey.templateColor,
        iconName: tpl?.iconName ?? iconUrlForTemplateAppKey(c.apiKey.templateAppKey ?? null),
        connectionId: c.id,
        templateId: c.apiKey.templateId,
        templateName: tpl?.name ?? c.apiKey.templateName,
        description: descriptionFor(appKey, category),
        popular: isPopular(appKey) || isPopular(c.apiKey.templateName),
        authType: "api_key",
        connectionType: null,
      });
    }
    return out;
  }, [mode, connList, templateById]);

  // Catalog rows — manifest apps + admin templates. This is the union of
  // "anything the user could connect", shown on every page.
  const popularEntries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const a of apps) {
      // Hide internal meta-adapters (dynamic-template) — they only represent
      // the "admin template" generic entry and would confuse the picker.
      if ((a as { internal?: boolean }).internal) continue;
      const availability = (a as { availability?: "stable" | "beta" | "deprecated" }).availability;
      // Deprecated manifests stay loadable for legacy destinations but
      // disappear from the picker so users don't pick something we're
      // sunsetting.
      if (availability === "deprecated") continue;
      const category = normalizeManifestCategory(a.category);
      const connectionType = (a as { connectionType?: string | null }).connectionType ?? null;
      out.push({
        kind: "manifest",
        id: `app-${a.key}`,
        name: a.name,
        subtitle: shortDescription(a.description),
        category,
        color: BRAND_COLOR[a.key] ?? "#3B82F6",
        iconName: a.icon,
        appKey: a.key,
        description: descriptionFor(a.key, category),
        popular: isPopular(a.key) || isPopular(a.name),
        authType: authByKey.get(a.key) ?? null,
        connectionType,
        availability,
      });
    }
    for (const tt of templates) {
      const tpl = tt as {
        category?: string;
        userVisibleFields?: string[] | null;
        appKey?: string | null;
        appIconUrl?: string | null;
      };
      const category = normalizeTemplateCategory(tpl.category ?? null);
      const connCount = connectionCountByTemplate.get(tt.id) ?? 0;
      const subtitle =
        mode === "destination" && connCount > 0
          ? `${connCount} saved key${connCount === 1 ? "" : "s"} · add another`
          : "";
      out.push({
        kind: "template",
        id: `tpl-${tt.id}`,
        name: tt.name,
        subtitle,
        category,
        color: tt.color,
        iconName: iconUrlForTemplateAppKey(tpl.appKey ?? null, tpl.appIconUrl ?? null),
        templateId: tt.id,
        templateName: tt.name,
        userVisibleFields: tpl.userVisibleFields ?? [],
        description: descriptionFor(tpl.appKey ?? tt.name, category),
        popular: isPopular(tpl.appKey) || isPopular(tt.name),
        authType: "api_key",
        connectionType: null,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [apps, templates, connectionCountByTemplate, authByKey, mode]);

  // Sidebar counts — computed off the full union (manifest + template). The
  // sidebar reflects the catalog, not the user's connections.
  const categoryCounts = useMemo(() => {
    const counts: Record<SidebarId, number> = {
      home: 0,
      apps: 0,
      messaging: 0,
      data: 0,
      webhooks: 0,
      affiliate: 0,
      crm: 0,
      custom: 0,
    };
    for (const e of popularEntries) {
      counts.home += 1;
      counts.apps += 1;
      counts[e.category] += 1;
      if (e.kind === "template") counts.custom += 1;
    }
    return counts;
  }, [popularEntries]);

  // Filtering ────────────────────────────────────────────────────────────────

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
      e.subtitle.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q)
    );
  };
  const topFiltered = useMemo(() => topEntries.filter(filterEntry), [topEntries, activeNav, search]);
  const popularFiltered = useMemo(() => popularEntries.filter(filterEntry), [popularEntries, activeNav, search]);

  // Click routing ────────────────────────────────────────────────────────────

  const createDestinationFromConnection = async (
    connectionId: number,
    rowId: string,
    nameHint: string,
  ) => {
    setBusyRow(rowId);
    try {
      const res = await createFromConnection.mutateAsync({ connectionId });
      await utils.destinations.list.refetch();
      onDestinationReady?.(res.id, res.name, "custom");
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

    // ── Existing connection: only reachable in destination mode ────────────
    if (entry.kind === "existingConnection") {
      void createDestinationFromConnection(entry.connectionId, entry.id, entry.name);
      return;
    }

    // ── Manifest app ───────────────────────────────────────────────────────
    if (entry.kind === "manifest") {
      // Destination mode: hand off to wizard's inline creator. It handles
      // OAuth/bot/HTTP setup and adds the destination itself.
      if (mode === "destination") {
        onOpenChange(false);
        onPickManifestApp?.(entry.appKey);
        return;
      }

      // Connection mode: run the app-specific add flow inline.
      if (entry.appKey === "google-sheets") {
        void startGoogleOAuth();
        return;
      }
      if (entry.appKey === "telegram") {
        setTelegramOpen(true);
        return;
      }
      if (entry.authType === "oauth2" || entry.connectionType?.startsWith("oauth2")) {
        setOauth2BusyAppKey(entry.appKey);
        void startOAuth2(entry.appKey);
        return;
      }
      // http-webhook & misc → fall through to /destinations?type=…
      onOpenChange(false);
      setLocation(`/destinations?type=${entry.appKey}`);
      return;
    }

    // ── Template (CPA / admin-managed API key) ─────────────────────────────
    setApiKeyTemplate({
      id: entry.templateId,
      name: entry.name,
      userVisibleFields: entry.userVisibleFields,
      color: entry.color,
    });
  };

  // After ApiKeyConnectDialog persists a new connection:
  //   • connection mode: invalidate + close (the dialog already toasts success)
  //   • destination mode: chain into createFromConnection so the user lands
  //     in mapping in one hop instead of two
  const handleApiKeyCreated = async (connectionId: number, displayName: string) => {
    const tpl = apiKeyTemplate;
    setApiKeyTemplate(null);
    if (!tpl) return;
    utils.connections.list.invalidate();

    if (mode === "connection") {
      onConnectionCreated?.(connectionId, displayName);
      onOpenChange(false);
      return;
    }

    setBusyRow(`tpl-${tpl.id}`);
    try {
      const res = await createFromConnection.mutateAsync({ connectionId });
      await utils.destinations.list.refetch();
      onDestinationReady?.(res.id, res.name, "custom");
      onOpenChange(false);
      toast.success(`${displayName} added`);
    } catch (err) {
      toast.error((err as Error).message || "Failed to add destination");
    } finally {
      setBusyRow(null);
    }
  };

  // Track which row should render its own spinner (OAuth popup open).
  const busyKey: string | number | null = isGoogleConnecting
    ? "google-sheets"
    : isOAuth2Connecting
      ? oauth2BusyAppKey
      : null;

  const totalCatalogSize = apps.length + templates.length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-w-4xl p-0 overflow-hidden gap-0",
          "sm:max-w-[900px]",
        )}
      >
        <div className="flex h-[560px] max-h-[80vh] w-full">
          {/* ── Left sidebar (Wapi pastel categories + counts) ────────────── */}
          <aside className="w-[200px] shrink-0 border-r border-slate-200/70 bg-slate-50/40 dark:bg-sidebar dark:border-border/50 p-3 space-y-1">
            <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Categories
            </p>
            {SIDEBAR.map((item) => {
              const Icon = item.icon;
              const active = activeNav === item.id;
              const count = categoryCounts[item.id] ?? 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-sm transition-colors group",
                    active
                      ? "bg-white dark:bg-card shadow-sm ring-1 ring-slate-200/80 dark:ring-border/50 font-semibold text-foreground"
                      : "font-medium text-foreground/70 hover:bg-white/60 dark:hover:bg-card/40 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "h-7 w-7 rounded-lg flex items-center justify-center shrink-0 transition-all",
                      active
                        ? "bg-primary/10 dark:bg-primary/15 ring-1 ring-primary/30"
                        : item.iconBg,
                    )}
                  >
                    <Icon
                      className={cn("h-3.5 w-3.5", active ? "text-primary" : item.iconColor)}
                      strokeWidth={2.2}
                    />
                  </span>
                  <span className="truncate flex-1 text-left">{item.label}</span>
                  {count > 0 && (
                    <span
                      className={cn(
                        "shrink-0 inline-flex min-w-[20px] px-1.5 h-5 items-center justify-center rounded-full text-[10px] font-bold tabular-nums transition-colors",
                        active
                          ? "bg-primary/15 text-primary"
                          : "bg-slate-200/70 text-slate-600 dark:bg-muted dark:text-muted-foreground group-hover:bg-slate-200 dark:group-hover:bg-muted/80",
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </aside>

          {/* ── Right content ─────────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Search */}
            <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${totalCatalogSize}+ apps and tools...`}
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
                  {mode === "destination" && (
                    <Column
                      title="Your saved accounts"
                      empty="No saved keys yet — pick an app on the right to add one"
                      items={topFiltered}
                      onPick={handlePick}
                      busyKey={busyKey}
                      busyRow={busyRow}
                    />
                  )}
                  <Column
                    title={mode === "connection" ? "All apps" : "Popular apps"}
                    empty="Nothing else in this category"
                    items={popularFiltered}
                    onPick={handlePick}
                    busyKey={busyKey}
                    busyRow={busyRow}
                    /** In connection mode the "All apps" column spans both
                     *  columns of the grid because there's no saved-accounts
                     *  column next to it. */
                    fullSpan={mode === "connection"}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      {/* Telegram bot form — connection mode only (destination mode delegates
          to the wizard's inline creator). */}
      <TelegramConnectDialog
        open={telegramOpen}
        onOpenChange={setTelegramOpen}
        onCreated={() => {
          setTelegramOpen(false);
          onOpenChange(false);
        }}
      />

      {/* Admin template API-key form — shared by both modes. The chained
          createFromConnection path lives in handleApiKeyCreated above. */}
      <ApiKeyConnectDialog
        open={apiKeyTemplate !== null}
        onOpenChange={(v) => !v && setApiKeyTemplate(null)}
        template={apiKeyTemplate}
        onCreated={handleApiKeyCreated}
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
  busyRow,
  fullSpan,
}: {
  title: string;
  empty: string;
  items: Entry[];
  onPick: (e: Entry) => void;
  busyKey: string | number | null;
  busyRow: string | null;
  fullSpan?: boolean;
}) {
  return (
    <div className={cn(fullSpan && "sm:col-span-2")}>
      <h3 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="px-2 py-6 text-xs text-muted-foreground/70">{empty}</p>
      ) : (
        <ul className={cn("space-y-1", fullSpan && "grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 space-y-0")}>
          {items.map((e) => {
            const rowBusy =
              busyRow === e.id ||
              (e.kind === "manifest" && busyKey === e.appKey);
            const anyBusy = busyRow !== null || busyKey !== null;
            return (
              <li key={e.id}>
                <Row
                  entry={e}
                  onPick={onPick}
                  busy={rowBusy}
                  disabled={anyBusy && !rowBusy}
                />
              </li>
            );
          })}
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
  const auth = authBadgeFor({
    authType: entry.authType,
    connectionType: entry.connectionType,
    source: entry.kind === "template" ? "template" : "manifest",
  });
  const subtitle =
    busy
      ? "Connecting…"
      : entry.kind === "existingConnection"
        ? entry.subtitle
        : entry.subtitle || entry.description;

  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => onPick(entry)}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-xl border border-transparent p-3 text-left",
        "transition-[background-color,box-shadow,border-color] duration-200 ease-out",
        "hover:border-emerald-200/70 hover:bg-emerald-50/40 hover:shadow-[inset_3px_0_0_0_var(--primary)]",
        "dark:hover:bg-emerald-950/15 dark:hover:border-emerald-900/40",
        "active:scale-[0.99]",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span
        className={cn(
          appBrandIconTileClass("h-10 w-10 rounded-xl"),
          "transition-transform duration-200 group-hover:scale-105",
        )}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
        ) : entry.kind === "existingConnection" && !entry.iconName ? (
          <KeyRound className="h-5 w-5 text-zinc-600" strokeWidth={2.2} />
        ) : (
          <AppIcon name={entry.iconName} className="h-5 w-5" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-foreground transition-colors group-hover:text-emerald-700 dark:group-hover:text-emerald-400">
            {entry.name}
          </span>
          {entry.popular && entry.kind !== "existingConnection" && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900/40 dark:text-amber-400 shrink-0"
              title="Popular choice"
            >
              <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
              <span className="text-[9px] font-bold uppercase tracking-widest leading-none">
                Popular
              </span>
            </span>
          )}
          {entry.kind === "manifest" && entry.availability === "beta" && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-50 border border-sky-200 text-sky-700 dark:bg-sky-950/30 dark:border-sky-900/40 dark:text-sky-400 shrink-0"
              title="Beta — interface may still change"
            >
              <span className="text-[9px] font-bold uppercase tracking-widest leading-none">
                Beta
              </span>
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>

      {!busy && (
        <span
          className={cn(
            "shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-widest leading-none whitespace-nowrap",
            auth.className,
          )}
        >
          {auth.label}
        </span>
      )}
    </button>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
        <Plus className="h-5 w-5 text-muted-foreground" />
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

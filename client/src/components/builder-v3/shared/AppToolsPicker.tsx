/**
 * AppToolsPicker — Albato-style two-column picker: Apps + Tools.
 *
 * Replicates the layout at https://albato.com/app/bundle/create/<id> on the
 * trigger and action setup modals. Structure:
 *
 *   ┌────────────┬─────────────────────────────────────┐
 *   │  Sidebar   │  Search                             │
 *   │  • All     ├─────────────────────────────────────┤
 *   │  • Apps    │  Apps              Tools            │
 *   │  • Tools   │  ▢ Facebook        ▢ Schedule       │
 *   │            │  ▢ 101             ▢ Webhook        │
 *   │            │  ▢ 123 Form        ▢ RSS            │
 *   │            │  ▢ 1C:Accounting                    │
 *   │            │  ...                                │
 *   └────────────┴─────────────────────────────────────┘
 *
 * Behaviour matrix:
 *   - "All" tab: both columns visible (Apps + Tools)
 *   - "Apps" tab: only Apps column, full width
 *   - "Tools" tab: only Tools column, full width
 *   - Search filters both columns. Items below the visible category get a
 *     "+N more" hint via scroll — no virtualisation yet because Phase 1
 *     ships < 30 apps and < 10 tools.
 *
 * This component is generic over what counts as an "app" or a "tool", so it
 * can be reused for both the trigger picker (small Apps list + Schedule/
 * Webhook/RSS tools) and the action picker (large Apps list from
 * `trpc.apps.list` + Albato AI/JS/Python/Filter/Router tools).
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import {
  AppIcon,
  appBrandIconTileClass,
  resolveAppIcon,
} from "@/components/destinations/appIcons";
import { Search, Home, LayoutGrid, Wrench } from "lucide-react";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface AppToolsItem {
  id: string;
  name: string;
  icon: string | null;
  description?: string;
  available?: boolean;
}

export type SidebarKey = "all" | "apps" | "tools" | string;

export interface AppToolsSidebarItem {
  id: SidebarKey;
  label: string;
  /** Lucide-style component reference. Optional — we fall back to a circle. */
  icon?: React.ComponentType<{ className?: string }>;
}

export interface AppToolsPickerProps {
  /** Sidebar tabs. Phase 1 trigger uses `[All, Apps, Tools]`. */
  sidebar: AppToolsSidebarItem[];
  /** Currently selected sidebar tab. */
  activeSidebar: SidebarKey;
  onSidebarChange: (key: SidebarKey) => void;

  /** Apps list — rendered in the left content column. */
  apps: AppToolsItem[];
  /** Tools list — rendered in the right content column. */
  tools: AppToolsItem[];

  onPickApp: (item: AppToolsItem) => void;
  onPickTool: (item: AppToolsItem) => void;

  searchPlaceholder?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AppToolsPicker({
  sidebar,
  activeSidebar,
  onSidebarChange,
  apps,
  tools,
  onPickApp,
  onPickTool,
  searchPlaceholder = "Search…",
}: AppToolsPickerProps) {
  const [search, setSearch] = React.useState("");

  const showApps = activeSidebar === "all" || activeSidebar === "apps";
  const showTools = activeSidebar === "all" || activeSidebar === "tools";

  const filteredApps = filterItems(apps, search);
  const filteredTools = filterItems(tools, search);

  return (
    // The picker occupies the entire scrollable body of BuilderShellModal.
    // We negate the shell's px-6 py-5 padding so the sidebar can sit
    // flush against the left edge and feel like part of the modal chrome.
    <div className="-mx-6 -my-5 flex h-full min-h-[450px]">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-[180px] shrink-0 border-r bg-muted/30 p-3 space-y-1">
        {sidebar.map((item) => {
          const Icon = item.icon ?? defaultSidebarIcon(item.id);
          const active = activeSidebar === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSidebarChange(item.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-background shadow-sm font-medium text-foreground"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span className="truncate text-left">{item.label}</span>
            </button>
          );
        })}
      </aside>

      {/* ── Right content ───────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Search bar */}
        <div className="border-b px-5 pt-4 pb-3 shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className={cn(
                "w-full rounded-md border-0 bg-muted/40 pl-9 pr-3 py-2 text-sm",
                "placeholder:text-muted-foreground/70",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              )}
            />
          </div>
        </div>

        {/* Two-column list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {filteredApps.length === 0 && filteredTools.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {`No matches for "${search}"`}
            </p>
          ) : (
            <div
              className={cn(
                "grid gap-x-8",
                showApps && showTools ? "grid-cols-2" : "grid-cols-1",
              )}
            >
              {showApps && (
                <ColumnList
                  title="Apps"
                  items={filteredApps}
                  onPick={onPickApp}
                  iconRenderer={renderAppIconChip}
                />
              )}
              {showTools && (
                <ColumnList
                  title="Tools"
                  items={filteredTools}
                  onPick={onPickTool}
                  iconRenderer={renderToolIconChip}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

interface ColumnListProps {
  title: string;
  items: AppToolsItem[];
  onPick: (item: AppToolsItem) => void;
  iconRenderer: (item: AppToolsItem) => React.ReactNode;
}

function ColumnList({ title, items, onPick, iconRenderer }: ColumnListProps) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const disabled = item.available === false;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item)}
                disabled={disabled}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors",
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "hover:bg-accent/60 cursor-pointer",
                )}
              >
                {iconRenderer(item)}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {item.name}
                </span>
                {disabled && (
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Soon
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function renderAppIconChip(item: AppToolsItem) {
  return (
    <span className={appBrandIconTileClass("h-8 w-8")}>
      <AppIcon name={item.icon} className="h-5 w-5" />
    </span>
  );
}

function renderToolIconChip(item: AppToolsItem) {
  // Tools use the same brand chip but tinted (lavender) so they read as a
  // different class of thing — matches Albato's purple tool icons.
  const Icon = item.icon ? resolveAppIcon(item.icon) : Wrench;
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
        "bg-violet-100 dark:bg-violet-950/40",
      )}
    >
      <Icon className="h-4 w-4 text-violet-600 dark:text-violet-400" />
    </span>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterItems(items: AppToolsItem[], query: string): AppToolsItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.name.toLowerCase().includes(q));
}

function defaultSidebarIcon(
  id: SidebarKey,
): React.ComponentType<{ className?: string }> {
  switch (id) {
    case "all":
      return Home;
    case "apps":
      return LayoutGrid;
    case "tools":
      return Wrench;
    default:
      return LayoutGrid;
  }
}

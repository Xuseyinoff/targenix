/**
 * DestinationEditor — the destination block inside Step 2 of
 * IntegrationWizardV2.
 *
 * Two views, toggled by internal `showPicker` state:
 *   • Chip view   — compact summary of the selected destinations, with
 *                   "add another" / "change" actions.
 *   • Picker view — app shortcut cards + a searchable list of existing
 *                   destinations to add.
 *
 * Selection state lives in the parent wizard; this component reports
 * toggles via `onToggle` and creator-open requests via the other callbacks.
 *
 * Extracted from IntegrationWizardV2.tsx.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, CheckCircle2, Plus, Search, X } from "lucide-react";
import { AppIcon, appBrandIconTileClass, appIconRingClass } from "@/components/destinations/appIcons";
import { isSupportedAppKey } from "@/components/destinations/createPayload";
import { iconForCategory } from "@/pages/lead-routing/categoryMeta";
import { LoadingBar } from "./wizardPrimitives";

interface DestinationListItem {
  id: number;
  name: string;
  appKey: string;
  templateName?: string | null;
  category: string;
}

export interface DestinationEditorProps {
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

export function DestinationEditor({
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

  const appIconByKey = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of appList) m.set(a.key, a.icon ?? null);
    return m;
  }, [appList]);

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
          const rawIcon = appIconByKey.get(d.appKey) ?? null;
          const CategoryIcon = iconForCategory(d.category);
          return (
            <div
              key={id}
              className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-3"
            >
              <div className={appBrandIconTileClass("h-9 w-9 rounded-lg")}>
                {rawIcon ? (
                  <AppIcon name={rawIcon} className="h-4 w-4" />
                ) : (
                  <CategoryIcon className="h-4 w-4 text-zinc-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{d.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {idx === 0 ? "Primary · drives mapping" : `Destination ${idx + 1}`}
                  {" · "}
                  {d.templateName || d.appKey}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onToggle(id, d.name, d.appKey)}
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
                    appBrandIconTileClass(
                      "h-11 w-11 rounded-xl transition-transform group-hover:scale-105",
                    ),
                  )}
                >
                  <AppIcon name={app.icon} className="h-5 w-5" />
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
                const rawIcon = appIconByKey.get(d.appKey) ?? null;
                const CategoryIcon = iconForCategory(d.category);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => handleToggle(d.id, d.name, d.appKey)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors",
                      isSelected ? "bg-primary/8 font-medium" : "hover:bg-muted/60",
                    )}
                  >
                    <div className={appBrandIconTileClass("h-6 w-6 rounded")}>
                      {rawIcon ? (
                        <AppIcon name={rawIcon} className="h-3 w-3" />
                      ) : (
                        <CategoryIcon className="h-3 w-3 text-zinc-600" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate leading-tight">{d.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {d.templateName || d.appKey}
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

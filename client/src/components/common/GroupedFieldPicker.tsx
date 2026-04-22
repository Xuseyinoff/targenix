/**
 * GroupedFieldPicker — Make.com-style single-select popover with a searchable,
 * collapsible, grouped tree of options.
 *
 * Why this exists separate from MapToggleWrapper's VariablePicker:
 *   • MapToggleWrapper's picker is "append" semantics — clicking an entry
 *     APPENDS `{{key}}` to the current value. That fits free-text fields
 *     (URL template, header values, JSON body).
 *   • This component is "replace" semantics — clicking an entry REPLACES
 *     the whole value with the picked key. That fits 1:1 mapping dropdowns
 *     (admin-template "Full Name ← FB form field" rows, custom webhook
 *     source pickers, etc.).
 *
 * Both share the same visual language (search bar at top, collapsible
 * groups with counts, {{key}} badge on the right) so the product feels
 * consistent everywhere a user picks a trigger variable.
 *
 * Design notes:
 *   • Single-file, zero-dependency (beyond shadcn Popover + lucide icons).
 *     Keeping it self-contained means pages can import it without dragging
 *     in the entire DynamicForm engine.
 *   • Grouped data shape matches DynamicForm's `VariableGroup` exactly so
 *     call sites that already build that structure (IntegrationWizardV2's
 *     triggerVariableGroups) can reuse it verbatim.
 *   • The trigger button is intentionally styled like a shadcn SelectTrigger
 *     so swapping an existing <Select> for this picker is a visual no-op
 *     for the rest of the row.
 */

import * as React from "react";
import { ChevronDown, ChevronRight, Search, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

export interface GroupedFieldPickerOption {
  key: string;
  label: string;
  description?: string;
}

export interface GroupedFieldPickerGroup {
  id: string;
  label: string;
  description?: string;
  options: GroupedFieldPickerOption[];
  /** If true (default) the group starts expanded. */
  defaultExpanded?: boolean;
}

export interface GroupedFieldPickerProps {
  groups: GroupedFieldPickerGroup[];
  /** Currently selected key, or null/"" when no selection. */
  value: string | null | undefined;
  onChange: (key: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Classes forwarded to the trigger button (same slot as SelectTrigger). */
  className?: string;
  /** Hide the mono {{key}} badge on the right of each row (default: show). */
  hideKeyBadge?: boolean;
  /** Empty-state message when no groups have any options at all. */
  emptyMessage?: string;
  /** Optional short blurb rendered above the option list. */
  description?: string;
}

export function GroupedFieldPicker({
  groups,
  value,
  onChange,
  placeholder = "Pick a value…",
  disabled,
  className,
  hideKeyBadge,
  emptyMessage = "No options available.",
  description,
}: GroupedFieldPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  // Per-group collapse state: initialised from `defaultExpanded` and kept
  // explicit so users can fold a group they don't care about even after
  // clearing the search filter.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const g of groups) if (g.defaultExpanded === false) s.add(g.id);
    return s;
  });

  React.useEffect(() => {
    setCollapsed(() => {
      const s = new Set<string>();
      for (const g of groups) if (g.defaultExpanded === false) s.add(g.id);
      return s;
    });
  }, [groups]);

  // Find the currently-selected option across all groups so the trigger
  // button can display its human label (not the raw key).
  const selected = React.useMemo(() => {
    if (!value) return null;
    for (const g of groups) {
      const hit = g.options.find((o) => o.key === value);
      if (hit) return { group: g, option: hit };
    }
    return null;
  }, [groups, value]);

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const q = query.trim().toLowerCase();
  const filteredGroups = React.useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.key.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, q]);

  const totalOptions = groups.reduce((n, g) => n + g.options.length, 0);

  const pickAndClose = (k: string) => {
    onChange(k);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || totalOptions === 0}
          className={cn(
            // Styled to match shadcn's SelectTrigger so row heights and
            // spacing stay identical when we swap a <Select> for this picker.
            "flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-1 text-xs",
            "ring-offset-background placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-50",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {selected ? (
              <>
                <span className="truncate font-medium text-foreground">
                  {selected.option.label}
                </span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  ({selected.option.key})
                </span>
              </>
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-80 p-0"
        onOpenAutoFocus={(e) => {
          // Don't auto-focus the first option — we want focus on the search
          // box so keyboard users can filter immediately.
          e.preventDefault();
        }}
      >
        {/* Search bar */}
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {description && !q && (
          <p className="border-b px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
            {description}
          </p>
        )}

        {/* Tree */}
        <div className="max-h-80 overflow-auto py-1">
          {totalOptions === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No results for &quot;{query}&quot;
            </div>
          ) : (
            filteredGroups.map((g) => {
              // While a search is active, force groups open so the user
              // sees every hit without extra clicks.
              const isCollapsed = !q && collapsed.has(g.id);
              return (
                <div key={g.id} className="px-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className={cn(
                      "flex w-full items-center gap-1 rounded-md px-2 py-1 text-left transition-colors",
                      "hover:bg-accent/50",
                    )}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {g.label}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground/70">
                      {g.options.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul className="mb-1 ml-4 border-l border-border/60 pl-1">
                      {g.options.map((o) => {
                        const isSel = value === o.key;
                        return (
                          <li key={o.key}>
                            <button
                              type="button"
                              onClick={() => pickAndClose(o.key)}
                              className={cn(
                                "group flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left",
                                "hover:bg-primary/10",
                                isSel && "bg-primary/5",
                              )}
                            >
                              <span className="flex min-w-0 flex-col">
                                <span
                                  className={cn(
                                    "truncate text-xs font-medium text-foreground",
                                    "group-hover:text-primary",
                                  )}
                                >
                                  {o.label}
                                </span>
                                {o.description && (
                                  <span className="truncate text-[10px] text-muted-foreground">
                                    {o.description}
                                  </span>
                                )}
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                {isSel && (
                                  <Check className="h-3 w-3 text-primary" />
                                )}
                                {!hideKeyBadge && (
                                  <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                                    {o.key}
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

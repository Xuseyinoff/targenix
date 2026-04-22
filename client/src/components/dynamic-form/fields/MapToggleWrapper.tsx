/**
 * MapToggleWrapper — Make.com / Zapier-style variable picker that lets any
 * scalar field mix static text with trigger variables.
 *
 * UI model (Make.com parity):
 *   • Next to the label we render a compact "+ Variable" popover trigger.
 *   • The popover shows a collapsible TREE of variable groups (e.g.
 *     "Facebook Lead Ads — New Lead" with sub-groups "Lead metadata" and
 *     "Field data"). Each leaf is a pickable variable.
 *   • A search box at the top filters leaves across every group — groups
 *     that have no remaining matches collapse automatically.
 *   • Clicking a leaf APPENDS `{{key}}` to the current string value — the
 *     exact token affiliateService.injectVariables() expands at delivery
 *     time. Repeated picks keep appending so users can compose a sentence
 *     like "Hello {{full_name}}, {{phone_number}}" one variable at a time.
 *   • A chip row under the input surfaces the tokens currently present in
 *     the field value so the user can verify wiring without scanning the
 *     raw string.
 *
 * Public API:
 *   - `field.mappable: true` on the manifest ConfigField, AND
 *   - The host page passes a non-empty `availableVariables` into DynamicForm.
 *   Both missing → the wrapper is a transparent pass-through, so every
 *   existing form renders byte-for-byte identically to before.
 *
 * `availableVariables` may be either:
 *   - A flat `AvailableVariable[]`   (backward-compatible legacy shape), OR
 *   - A grouped `VariableGroup[]`    (new, tree-rendered)
 *   A flat array is internally normalised to a single auto-expanded group.
 */

import * as React from "react";
import { Zap, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import type { ConfigField } from "../types";

// ─── Public types ────────────────────────────────────────────────────────────

export type AvailableVariable = {
  key: string;
  label: string;
  /** Optional one-line helper shown under the label. */
  description?: string;
};

export type VariableGroup = {
  /** Stable id for React keying / collapse state. */
  id: string;
  /** Display label, e.g. "Field data", "Lead metadata". */
  label: string;
  /** Optional helper shown muted next to the group name. */
  description?: string;
  /** Variables in this group (leaves). */
  variables: AvailableVariable[];
  /** If true (default) the group starts expanded. */
  defaultExpanded?: boolean;
};

export type VariableCatalogue = AvailableVariable[] | VariableGroup[];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** True when the array looks like VariableGroup[] (entries have `variables`). */
function isGroupedCatalogue(
  input: VariableCatalogue,
): input is VariableGroup[] {
  return input.length > 0 && "variables" in (input[0] as object);
}

/**
 * Normalise whatever the caller passed into a consistent VariableGroup[].
 * A flat array becomes a single auto-expanded "Variables" group so the rest
 * of the picker only has to handle one shape.
 */
export function toVariableGroups(
  input: VariableCatalogue | undefined,
): VariableGroup[] {
  if (!input || input.length === 0) return [];
  if (isGroupedCatalogue(input)) return input;
  return [
    {
      id: "default",
      label: "Variables",
      variables: input as AvailableVariable[],
      defaultExpanded: true,
    },
  ];
}

/** Collapse every group into a single flat list (used for token lookups). */
export function flattenVariables(
  input: VariableCatalogue | undefined,
): AvailableVariable[] {
  if (!input || input.length === 0) return [];
  if (!isGroupedCatalogue(input)) return input as AvailableVariable[];
  const out: AvailableVariable[] = [];
  for (const g of input) out.push(...g.variables);
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface MapToggleWrapperProps {
  field: ConfigField;
  /** Current value held in the surrounding form state. */
  value: unknown;
  /** Called with the next value — we only ever produce strings. */
  onChange: (next: unknown) => void;
  /** Variable catalogue — flat or grouped. Wrapper stays invisible when empty. */
  availableVariables?: VariableCatalogue;
  /** The underlying static renderer — TextField / SelectField / … */
  children: React.ReactNode;
  disabled?: boolean;
}

// Tokens embedded in the current value. Kept as a module-level regex so
// every render doesn't allocate a fresh one for the chip extraction below.
const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function MapToggleWrapper({
  field,
  value,
  onChange,
  availableVariables,
  children,
  disabled,
}: MapToggleWrapperProps) {
  const groups = React.useMemo(
    () => toVariableGroups(availableVariables),
    [availableVariables],
  );
  const hasVariables = groups.length > 0 && groups.some((g) => g.variables.length > 0);

  // Hidden completely when either the manifest hasn't opted in or the host
  // hasn't supplied variables — zero visual change for every existing form.
  if (!field.mappable || !hasVariables) {
    return <>{children}</>;
  }

  const stringValue = typeof value === "string" ? value : "";

  const insertVariable = (variableKey: string) => {
    const token = `{{${variableKey}}}`;
    // If the current value is empty, just drop the token in. Otherwise
    // append with a single space so "Hello " + {{name}} reads naturally.
    const sep =
      stringValue.length === 0 || /\s$/.test(stringValue) ? "" : " ";
    onChange(`${stringValue}${sep}${token}`);
  };

  // Extract tokens present in the current value — rendered as chips below
  // the input so the user can see their wiring without reading the raw
  // string. Deduplicated so "a={{x}}&b={{x}}" shows one chip, not two.
  const activeTokens = React.useMemo(() => {
    const flat = flattenVariables(availableVariables);
    const out = new Map<string, { key: string; label: string }>();
    // Array-ified to avoid the --downlevelIteration requirement on the
    // RegExpStringIterator returned by matchAll on older TS lib targets.
    const matches = Array.from(stringValue.matchAll(TOKEN_RE));
    for (const match of matches) {
      const k = match[1];
      if (out.has(k)) continue;
      const known = flat.find((v) => v.key === k);
      out.set(k, { key: k, label: known?.label ?? k });
    }
    return Array.from(out.values());
  }, [stringValue, availableVariables]);

  const clearToken = (tokenKey: string) => {
    const tokenRe = new RegExp(`\\s*\\{\\{\\s*${tokenKey}\\s*\\}\\}`, "g");
    onChange(stringValue.replace(tokenRe, "").trim());
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      data-field-key={field.key}
      data-mappable="true"
    >
      {/* Header row: label on the left, Variable picker on the right. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {field.label}
          {field.required && (
            <span aria-hidden className="ml-0.5 text-destructive">
              *
            </span>
          )}
        </span>
        <VariablePicker
          groups={groups}
          onPick={insertVariable}
          disabled={disabled}
        />
      </div>

      {/* Hide the inner label — we own it above — and keep the input itself
          exactly where the child renderer put it. No width/height overrides
          so Text/Select/Number all retain their native sizing. */}
      <div className="[&_label]:hidden [&_[data-field-key]>label]:hidden">
        {children}
      </div>

      {/* Active-token chips — visible only when the value contains at least
          one {{token}}. Helps users verify their wiring at a glance. Each
          chip is clickable (X button removes the token from the value). */}
      {activeTokens.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {activeTokens.map((t) => (
            <span
              key={t.key}
              className="inline-flex items-center gap-1 rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-medium"
            >
              <Zap className="h-2.5 w-2.5" strokeWidth={2.5} />
              {t.label}
              <button
                type="button"
                onClick={() => clearToken(t.key)}
                className="hover:text-primary/70"
                aria-label={`Remove ${t.label}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {field.description && (
        <p className="text-muted-foreground text-xs leading-snug">
          {field.description}
        </p>
      )}
    </div>
  );
}

// ─── Variable picker popover (tree + search) ─────────────────────────────────

interface VariablePickerProps {
  groups: VariableGroup[];
  onPick: (key: string) => void;
  disabled?: boolean;
}

function VariablePicker({ groups, onPick, disabled }: VariablePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  // Keep an explicit collapsed-id set so users can fold groups even after
  // a search filter cleared them. Defaults honour each group's preference.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const g of groups) if (g.defaultExpanded === false) s.add(g.id);
    return s;
  });

  // Refresh collapsed defaults when groups change (e.g. trigger swap).
  React.useEffect(() => {
    setCollapsed(() => {
      const s = new Set<string>();
      for (const g of groups) if (g.defaultExpanded === false) s.add(g.id);
      return s;
    });
  }, [groups]);

  const toggleGroup = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Search is case-insensitive and matches against label OR key so users
  // can find a variable by either name they remember it by.
  const q = query.trim().toLowerCase();
  const filteredGroups = React.useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        variables: g.variables.filter(
          (v) =>
            v.label.toLowerCase().includes(q) ||
            v.key.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.variables.length > 0);
  }, [groups, q]);

  const pickAndClose = (k: string) => {
    onPick(k);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
            "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
          aria-label="Insert lead variable"
        >
          <Zap className="h-3 w-3" strokeWidth={2.5} />
          Variable
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 p-0"
      >
        {/* Search bar */}
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search variables…"
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

        {/* Group tree */}
        <div className="max-h-80 overflow-auto py-1">
          {filteredGroups.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No variables match "{query}"
            </div>
          ) : (
            filteredGroups.map((g) => {
              // When a search is active, always show groups expanded so the
              // user sees every match without extra clicks.
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
                      {g.variables.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul className="mb-1 ml-4 border-l border-border/60 pl-1">
                      {g.variables.map((v) => (
                        <li key={v.key}>
                          <button
                            type="button"
                            onClick={() => pickAndClose(v.key)}
                            className={cn(
                              "group flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left",
                              "hover:bg-primary/10",
                            )}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-xs font-medium text-foreground group-hover:text-primary">
                                {v.label}
                              </span>
                              {v.description && (
                                <span className="truncate text-[10px] text-muted-foreground">
                                  {v.description}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                              {`{{${v.key}}}`}
                            </span>
                          </button>
                        </li>
                      ))}
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

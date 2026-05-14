/**
 * DependentSelect — single-column dropdown matching Albato's Page/Form
 * pickers (the ones with a built-in search box, a list, and a "Update"
 * refresh link at the bottom).
 *
 * Generic over the option type so the same component renders FB Pages,
 * FB Forms, and any future dependent dropdowns (CRM pipelines, sheet
 * tabs, …) without duplication.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Search, RefreshCw, Loader2 } from "lucide-react";

export interface DependentSelectOption {
  id: string;
  name: string;
}

export interface DependentSelectProps {
  /** Label shown above the trigger (required for screen readers). */
  label: string;
  /** Set to true to render the small red asterisk. */
  required?: boolean;
  /** Empty string ⇒ nothing selected yet. */
  value: string;
  onChange: (id: string, name: string) => void;
  options: DependentSelectOption[];
  placeholder?: string;
  /** Optional extra row shown at the top of the list (e.g. "All page forms"). */
  allOption?: DependentSelectOption;

  /** Disable the trigger entirely (e.g. parent not chosen yet). */
  disabled?: boolean;
  /** Show a small spinner inside the trigger. */
  loading?: boolean;
  /**
   * Optional refresh handler — when provided, an "Update" link is shown at
   * the bottom of the open list. Calling it re-runs the parent's data
   * fetch and shows the spinner while it runs.
   */
  onRefresh?: () => void;
  /** While the parent reload is in flight. */
  refreshing?: boolean;
}

export function DependentSelect({
  label,
  required,
  value,
  onChange,
  options,
  placeholder = "Select",
  allOption,
  disabled,
  loading,
  onRefresh,
  refreshing,
}: DependentSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedRow = [allOption, ...options].find(
    (o): o is DependentSelectOption => !!o && o.id === value,
  );

  const filtered = options.filter((o) =>
    o.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center justify-between rounded-md border bg-background px-3 py-2 text-left text-sm transition-colors",
            disabled
              ? "cursor-not-allowed text-muted-foreground"
              : "hover:bg-accent/40 cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          )}
        >
          <span className={cn(selectedRow ? "text-foreground" : "text-muted-foreground")}>
            {selectedRow ? selectedRow.name : placeholder}
          </span>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          )}
        </button>

        {open && (
          <div className="absolute left-0 right-0 z-30 mt-1 max-h-[280px] overflow-hidden rounded-md border bg-popover shadow-lg flex flex-col">
            <div className="border-b px-3 py-2 shrink-0">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  autoFocus
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className={cn(
                    "w-full rounded-md bg-muted/40 pl-7 pr-2 py-1.5 text-sm",
                    "placeholder:text-muted-foreground/70",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                  )}
                />
              </div>
            </div>
            <ul className="flex-1 overflow-y-auto py-1">
              {allOption && (
                <OptionRow
                  option={allOption}
                  selected={value === allOption.id}
                  onPick={() => {
                    onChange(allOption.id, allOption.name);
                    setOpen(false);
                    setSearch("");
                  }}
                />
              )}
              {filtered.length === 0 ? (
                <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {search ? `No matches for "${search}"` : "Nothing here yet."}
                </li>
              ) : (
                filtered.map((o) => (
                  <OptionRow
                    key={o.id}
                    option={o}
                    selected={value === o.id}
                    onPick={() => {
                      onChange(o.id, o.name);
                      setOpen(false);
                      setSearch("");
                    }}
                  />
                ))
              )}
            </ul>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className={cn(
                  "flex items-center justify-center gap-1.5 border-t px-3 py-2 text-xs font-medium text-muted-foreground transition-colors shrink-0",
                  "hover:bg-accent/40 hover:text-foreground",
                  refreshing && "cursor-wait opacity-60",
                )}
              >
                <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
                Update
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OptionRow({
  option,
  selected,
  onPick,
}: {
  option: DependentSelectOption;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60",
          selected && "bg-accent/40 font-medium",
        )}
      >
        <span className="truncate">{option.name}</span>
      </button>
    </li>
  );
}

/**
 * EventDropdown — Albato-style inline event picker.
 *
 * Looks like a Select trigger when closed; when opened, expands into an
 * inline panel underneath with a search input and a list of events.
 * Each event row shows: name (bold), description (muted), and a small
 * badge on the right (webhook / api / clock) indicating the trigger
 * delivery mode.
 *
 * We don't use Radix Select here because Select's content is rendered
 * in a portal-popover that can't accommodate per-item descriptions and
 * badges in the way Albato does. Instead this is a tiny controlled
 * disclosure — chevron rotates, list animates in.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Webhook, Zap, Clock, Search } from "lucide-react";
import type { TriggerEvent } from "@/components/builder-v3/catalog/triggerCatalog";

export interface EventDropdownProps {
  events: TriggerEvent[];
  /** Currently selected event id, or null when nothing chosen yet. */
  value: string | null;
  onChange: (eventId: string) => void;
  placeholder?: string;
}

export function EventDropdown({
  events,
  value,
  onChange,
  placeholder = "Select an event",
}: EventDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);

  const selected = events.find((e) => e.id === value) ?? null;

  // Close on outside click — keeps the disclosure feeling "lightweight"
  // even though it's not a portal-popover.
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const filtered = events.filter((e) =>
    e.label.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between rounded-md border bg-background px-3 py-2.5",
          "text-left text-sm hover:bg-accent/40 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        )}
      >
        <span className={cn(selected ? "text-foreground" : "text-muted-foreground")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-[320px] overflow-hidden rounded-md border bg-popover shadow-lg flex flex-col">
          {/* Search */}
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

          {/* List */}
          <ul className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                {`No matches for "${search}"`}
              </li>
            ) : (
              filtered.map((event) => {
                const disabled = !event.available;
                return (
                  <li key={event.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (disabled) return;
                        onChange(event.id);
                        setOpen(false);
                        setSearch("");
                      }}
                      disabled={disabled}
                      className={cn(
                        "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
                        disabled
                          ? "cursor-not-allowed opacity-50"
                          : "hover:bg-accent/60 cursor-pointer",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">
                          {event.label}
                        </p>
                        {event.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                            {event.description}
                          </p>
                        )}
                      </div>
                      <BadgePill kind={event.badge} />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function BadgePill({ kind }: { kind: TriggerEvent["badge"] }) {
  if (kind === "webhook") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
        title="A webhook trigger fires immediately after receiving data."
      >
        <Webhook className="h-3 w-3" /> Webhook
      </span>
    );
  }
  if (kind === "api") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
        title="Fetched via API on a schedule."
      >
        <Zap className="h-3 w-3" /> API
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      title="Polled on a fixed interval."
    >
      <Clock className="h-3 w-3" /> Polling
    </span>
  );
}

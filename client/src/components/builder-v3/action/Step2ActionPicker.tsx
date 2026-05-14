/**
 * action/Step2ActionPicker — pick which action (manifest module) to run.
 *
 * Most targenix manifests expose exactly one module today (e.g.
 * "send_message" for Telegram, "append_row" for Google Sheets), so this
 * step is functionally pre-filled when the manifest only has one option.
 * We still render the Albato-style dropdown so the layout is consistent
 * — and the UI is already ready for the day a manifest grows multiple
 * modules.
 */
import * as React from "react";
import { trpc } from "@/lib/trpc";
import {
  AppIcon,
  appBrandIconTileClass,
} from "@/components/destinations/appIcons";
import { ChevronDown, Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface ActionStep2Props {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

export function Step2ActionPicker({ state, dispatch }: ActionStep2Props) {
  const appKey = state.action.appKey;
  const { data: app, isLoading } = trpc.apps.get.useQuery(
    appKey ? { key: appKey } : (undefined as never),
    {
      enabled: !!appKey,
      staleTime: 5 * 60 * 1000,
    },
  );

  // Auto-select the only module when the manifest has exactly one — this
  // mirrors how Albato handles single-module integrations (the dropdown
  // appears "pre-filled" so the user moves forward with one fewer click).
  React.useEffect(() => {
    if (!app) return;
    if (state.action.moduleKey) return;
    const modules = app.modules ?? [];
    if (modules.length === 1) {
      dispatch({
        type: "PATCH_ACTION",
        patch: { moduleKey: modules[0].key },
      });
    }
  }, [app, state.action.moduleKey, dispatch]);

  if (isLoading || !app) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const modules = app.modules ?? [];

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className={appBrandIconTileClass("h-10 w-10")}>
          <AppIcon name={app.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">{app.name}</h3>
          <p className="text-xs text-muted-foreground">
            {app.description ?? "Choose what should happen on each lead."}
          </p>
        </div>
      </header>

      <div className="space-y-2">
        <label className="block text-sm font-medium">
          Choose an action you want to perform
        </label>
        <ModuleDropdown
          modules={modules}
          value={state.action.moduleKey}
          onChange={(moduleKey) =>
            dispatch({ type: "PATCH_ACTION", patch: { moduleKey } })
          }
        />
        <p className="text-xs text-muted-foreground">
          This action will run when the trigger fires.
        </p>
      </div>
    </div>
  );
}

// ─── Module dropdown ─────────────────────────────────────────────────────────

interface AppModule {
  key: string;
  name: string;
  description?: string | null;
}

function ModuleDropdown({
  modules,
  value,
  onChange,
}: {
  modules: AppModule[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const ref = React.useRef<HTMLDivElement>(null);

  const selected = modules.find((m) => m.key === value) ?? null;

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current || !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = modules.filter((m) =>
    m.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div ref={ref} className="relative">
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
          {selected ? selected.name : "Select an action"}
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
          {modules.length > 4 && (
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
          )}
          <ul className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                No matching action
              </li>
            ) : (
              filtered.map((m) => (
                <li key={m.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(m.key);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/60",
                      value === m.key && "bg-accent/40",
                    )}
                  >
                    <span className="text-sm font-medium">{m.name}</span>
                    {m.description && (
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {m.description}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

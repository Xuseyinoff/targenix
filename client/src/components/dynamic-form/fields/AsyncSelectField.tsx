/**
 * AsyncSelectField — dropdown whose options come from appsRouter.loadOptions.
 *
 * The field declares `optionsSource` in the manifest; the outer form passes
 * the current `appKey`, the selected `connectionId`, and any parent-field
 * values collected from `dependsOn[]`. When any of those change, React Query
 * refetches automatically.
 *
 * Readiness:
 *   - If any declared dependency is missing/empty, the field is rendered
 *     disabled with a "Pick X first" hint. We don't fire the request.
 *   - While the query is in-flight, the trigger shows a spinner.
 *   - On error, the trigger shows the backend message as a tooltip and the
 *     form renderer surfaces the same message under the field.
 */

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps, LoadedOption } from "../types";

export interface AsyncSelectFieldProps extends BaseFieldProps {
  /** Manifest key for the parent app — used to authorise the loader call. */
  appKey: string;
  /** Current selection; persisted as a bare string so JSON round-trips cleanly. */
  value: string | null;
  onChange: (value: string | null, meta?: LoadedOption["meta"]) => void;
  /** Connection row id selected elsewhere in the form. Null → field is idle. */
  connectionId: number | null;
  /**
   * Values of the parent fields named in field.dependsOn[], plus any free
   * search text. Merged into the loadOptions `params`. Empty/undefined values
   * are filtered out before the request so the loader sees only meaningful
   * inputs.
   */
  params?: Record<string, unknown>;
}

const CLEAR_SENTINEL = "__clear__";

function areAllDepsSatisfied(
  dependsOn: string[] | undefined,
  params: Record<string, unknown> | undefined,
  connectionId: number | null,
): boolean {
  if (!dependsOn || dependsOn.length === 0) return true;
  for (const dep of dependsOn) {
    if (dep === "connectionId") {
      if (connectionId == null) return false;
      continue;
    }
    const raw = params?.[dep];
    if (raw == null) return false;
    if (typeof raw === "string" && raw.trim() === "") return false;
    if (Array.isArray(raw) && raw.length === 0) return false;
  }
  return true;
}

function cleanParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

export function AsyncSelectField({
  field,
  appKey,
  value,
  onChange,
  connectionId,
  params,
  disabled,
  error,
  hideLabel,
  className,
}: AsyncSelectFieldProps) {
  const depsReady = areAllDepsSatisfied(field.dependsOn, params, connectionId);
  const source = field.optionsSource ?? "";
  const canClear = !field.required;

  const query = trpc.apps.loadOptions.useQuery(
    {
      appKey,
      source,
      connectionId: connectionId ?? null,
      params: cleanParams(params),
    },
    {
      enabled: depsReady && Boolean(source),
      staleTime: 30_000,
      retry: 0,
    },
  );

  const options: LoadedOption[] = React.useMemo(() => {
    const raw = query.data?.options ?? [];
    return raw.map((o) => ({ value: o.value, label: o.label, meta: o.meta }));
  }, [query.data]);

  const fetchError =
    query.error?.message ??
    null;

  // If the underlying list changes and the selected value is no longer valid,
  // clear the selection so the parent form doesn't send a stale id.
  React.useEffect(() => {
    if (!query.data || value == null) return;
    if (!options.some((o) => o.value === value)) {
      onChange(null);
    }
    // `onChange` intentionally omitted — parent forms rebind it on every
    // render; adding it would loop. `value` is stable per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const helperHint = !depsReady ? hintForMissingDeps(field.dependsOn) : null;

  return (
    <FieldShell
      field={field}
      disabled={disabled || !depsReady}
      error={error ?? fetchError ?? undefined}
      hideLabel={hideLabel}
      className={className}
      htmlFor={field.key}
    >
      <div className="flex items-center gap-2">
        <Select
          value={value ?? ""}
          onValueChange={(next) => {
            if (next === CLEAR_SENTINEL) {
              onChange(null);
              return;
            }
            const picked = options.find((o) => o.value === next);
            onChange(next, picked?.meta);
          }}
          disabled={disabled || !depsReady || query.isLoading}
        >
          <SelectTrigger
            id={field.key}
            aria-invalid={Boolean(error || fetchError)}
            aria-required={field.required}
            className="flex-1"
          >
            {query.isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </span>
            ) : (
              <SelectValue placeholder={helperHint ?? field.placeholder ?? "Select…"} />
            )}
          </SelectTrigger>
          <SelectContent>
            {canClear && value ? (
              <SelectItem value={CLEAR_SENTINEL} className="text-muted-foreground italic">
                — clear —
              </SelectItem>
            ) : null}
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
            {!query.isLoading && options.length === 0 && (
              <div className="px-2 py-1.5 text-muted-foreground text-xs">
                {depsReady ? "No matches." : helperHint ?? "Waiting…"}
              </div>
            )}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 w-9 p-0"
          onClick={() => query.refetch()}
          disabled={disabled || !depsReady || query.isFetching}
          aria-label="Refresh options"
          title="Refresh options"
        >
          {query.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>
    </FieldShell>
  );
}

function hintForMissingDeps(deps: string[] | undefined): string | null {
  if (!deps || deps.length === 0) return null;
  if (deps.includes("connectionId")) return "Pick a connection first.";
  return `Fill in ${deps.join(", ")} first.`;
}

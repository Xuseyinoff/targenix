/**
 * FieldMappingField — destination-column → lead-variable map.
 *
 * Shape of `value`:
 *   { [destinationColumn: string]: string }       // RHS is a template, e.g. "{{full_name}}"
 *
 * At Commit 3a this is a compact table with one row per destination column
 * returned by `headersSource`. Each row has:
 *   - the column name (left, read-only label from the loader)
 *   - a freeform text input where the user types the value / template
 *
 * The Make.com-style drag-and-drop variable picker arrives in Commit 3b
 * alongside the DynamicForm root component that knows which variables are
 * available for the current trigger (Facebook Lead Ads fields).
 *
 * The component takes care of:
 *   - loading headers via trpc.apps.loadOptions when deps are satisfied
 *   - graceful empty/loading/error states
 *   - auto-pruning mapping entries whose column has disappeared upstream
 */

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export type FieldMapping = Record<string, string>;

export interface FieldMappingFieldProps extends BaseFieldProps {
  appKey: string;
  value: FieldMapping;
  onChange: (next: FieldMapping) => void;
  connectionId: number | null;
  params?: Record<string, unknown>;
  /**
   * Variables available from the trigger (e.g. Facebook lead fields). Rendered
   * under the table as a quick-reference chip row so users know what tokens
   * they can type. Optional — leave empty for a bare text-mapping experience.
   */
  availableVariables?: Array<{ key: string; label: string }>;
}

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

export function FieldMappingField({
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
  availableVariables,
}: FieldMappingFieldProps) {
  const depsReady = areAllDepsSatisfied(field.dependsOn, params, connectionId);
  const source = field.headersSource ?? "";

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

  const columns = React.useMemo(() => {
    const raw = query.data?.options ?? [];
    return raw.map((o) => ({ key: o.value, label: o.label }));
  }, [query.data]);

  // Prune mapping entries whose column has disappeared upstream. We do NOT
  // auto-add defaults for new columns — the user should consciously decide
  // what to put in a freshly-added sheet column.
  React.useEffect(() => {
    if (!query.data) return;
    const valid = new Set(columns.map((c) => c.key));
    const next: FieldMapping = {};
    let changed = false;
    for (const [k, v] of Object.entries(value)) {
      if (valid.has(k)) next[k] = v;
      else changed = true;
    }
    if (changed) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const setRow = (columnKey: string, template: string) => {
    onChange({ ...value, [columnKey]: template });
  };

  const fetchError = query.error?.message ?? null;

  return (
    <FieldShell
      field={field}
      disabled={disabled || !depsReady}
      error={error ?? fetchError ?? undefined}
      hideLabel={hideLabel}
      className={className}
    >
      <div
        className={cn(
          "rounded-md border bg-background",
          disabled && "opacity-70",
        )}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground">
            {depsReady
              ? `Destination columns (${columns.length})`
              : hintForMissingDeps(field.dependsOn) ?? "Waiting for dependencies…"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => query.refetch()}
            disabled={disabled || !depsReady || query.isFetching}
            aria-label="Refresh columns"
            title="Refresh columns"
          >
            {query.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        <div className="divide-y">
          {query.isLoading && (
            <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading columns…
            </div>
          )}

          {!query.isLoading && depsReady && columns.length === 0 && !fetchError && (
            <div className="px-3 py-4 text-muted-foreground text-sm">
              No columns found. Check the destination and press refresh.
            </div>
          )}

          {!query.isLoading &&
            columns.map((col) => (
              <div
                key={col.key}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 px-3 py-2 items-center"
              >
                <div className="text-sm font-medium truncate" title={col.label}>
                  {col.label}
                </div>
                <Input
                  value={value[col.key] ?? ""}
                  onChange={(e) => setRow(col.key, e.target.value)}
                  placeholder="{{full_name}} or plain text"
                  disabled={disabled}
                  aria-label={`Mapping for ${col.label}`}
                  className="font-mono text-xs"
                />
              </div>
            ))}
        </div>

        {availableVariables && availableVariables.length > 0 && (
          <div className="px-3 py-2 border-t bg-muted/20 flex flex-wrap gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground self-center mr-1">
              Variables:
            </span>
            {availableVariables.map((v) => (
              <code
                key={v.key}
                className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border"
                title={v.label}
              >
                {`{{${v.key}}}`}
              </code>
            ))}
          </div>
        )}
      </div>
    </FieldShell>
  );
}

function hintForMissingDeps(deps: string[] | undefined): string | null {
  if (!deps || deps.length === 0) return null;
  if (deps.includes("connectionId")) return "Pick a connection first.";
  return `Fill in ${deps.join(", ")} first.`;
}

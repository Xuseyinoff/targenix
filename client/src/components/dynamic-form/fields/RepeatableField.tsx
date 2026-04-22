/**
 * RepeatableField — Make.com "+ Add header / + Add query parameter" row
 * builder for `type: "repeatable"` fields.
 *
 * Model
 * ─────
 *   value  : Array<Record<string, unknown>>            (one record per row)
 *   itemFields : ConfigField[] (sub-field shape)       (declared by manifest)
 *
 * Each row is rendered as a flat horizontal strip of inputs — no gaps, no
 * extra headers — so the form reads like Make.com / Zapier's compact table
 * instead of N stacked mini-cards. Every row can be removed with an "X"
 * button; the "+ Add <label>" button below appends a freshly-seeded row.
 *
 * What this file deliberately does NOT do:
 *   • Recurse into nested repeatables or groups — the manifest validator
 *     flags those as illegal, so we keep the renderer one-level deep.
 *   • Own field-level error state. Errors for repeatable fields surface as
 *     a single row-scoped message on `field.key`, matching validation.ts's
 *     "Row N: …" output.
 */

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps, ConfigField } from "../types";
import { initialRowForRepeatable } from "../validation";

export interface RepeatableRowValues {
  [subKey: string]: unknown;
}

export interface RepeatableFieldProps extends BaseFieldProps {
  value: RepeatableRowValues[];
  onChange: (next: RepeatableRowValues[]) => void;
}

export function RepeatableField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: RepeatableFieldProps) {
  const sub = field.itemFields ?? [];
  const max = field.maxItems;
  const min = Math.max(0, field.minItems ?? 0);
  const canAdd = !disabled && (typeof max !== "number" || value.length < max);
  const canRemove = (_idx: number) => !disabled && value.length > min;
  const addLabel = field.addButtonLabel ?? `Add ${field.label.toLowerCase()}`;

  const patchRow = (rowIdx: number, subKey: string, subValue: unknown) => {
    const next = value.slice();
    next[rowIdx] = { ...(next[rowIdx] ?? {}), [subKey]: subValue };
    onChange(next);
  };

  const addRow = () => {
    if (!canAdd) return;
    onChange([...value, initialRowForRepeatable(field)]);
  };

  const removeRow = (rowIdx: number) => {
    if (!canRemove(rowIdx)) return;
    const next = value.slice();
    next.splice(rowIdx, 1);
    onChange(next);
  };

  return (
    <FieldShell
      field={field}
      disabled={disabled}
      error={error}
      hideLabel={hideLabel}
      className={className}
    >
      <div className="flex flex-col gap-2">
        {value.length === 0 && (
          <p className="text-[11px] text-muted-foreground/70 italic">
            No rows yet — click "{addLabel}" to add one.
          </p>
        )}

        {value.map((row, rowIdx) => (
          <div
            key={rowIdx}
            className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/20 p-2"
          >
            <div className="grid flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              {sub.map((sf) => (
                <RepeatableCell
                  key={sf.key}
                  field={sf}
                  value={row?.[sf.key]}
                  onChange={(v) => patchRow(rowIdx, sf.key, v)}
                  disabled={disabled}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => removeRow(rowIdx)}
              disabled={!canRemove(rowIdx)}
              className={cn(
                "mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
                "hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 disabled:cursor-not-allowed",
              )}
              aria-label={`Remove row ${rowIdx + 1}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addRow}
            disabled={!canAdd}
            className="h-8 gap-1.5 px-2 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            {addLabel}
            {typeof max === "number" && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({value.length}/{max})
              </span>
            )}
          </Button>
        </div>
      </div>
    </FieldShell>
  );
}

// ─── Single-cell renderer ────────────────────────────────────────────────────
// Kept inside this file so the repeatable is self-contained. Supports the
// three shapes that real repeatable fields actually need today — text,
// select, boolean. New row types can be added when a manifest requires them;
// keeping the surface tight prevents the repeatable from becoming a second,
// divergent copy of the main DynamicForm dispatcher.

function RepeatableCell({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  if (field.type === "select") {
    return (
      <select
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "h-9 w-full rounded-md border border-input bg-background px-2 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-primary/30",
        )}
        aria-label={field.label}
      >
        <option value="" disabled>
          {field.placeholder ?? field.label}
        </option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="flex h-9 items-center gap-2 px-1">
        <Switch
          checked={value === true}
          onCheckedChange={(v) => onChange(v)}
          disabled={disabled}
          aria-label={field.label}
        />
        <span className="text-xs text-muted-foreground">{field.label}</span>
      </div>
    );
  }

  // Default: text / password / anything string-like. Sensitive fields honour
  // the password mask without pulling in the full PasswordField chrome.
  return (
    <Input
      type={field.sensitive || field.type === "password" ? "password" : "text"}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder ?? field.label}
      disabled={disabled}
      maxLength={field.validation?.maxLength}
      className="h-9 text-sm"
      aria-label={field.label}
    />
  );
}

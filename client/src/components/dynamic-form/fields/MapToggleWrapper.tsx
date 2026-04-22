/**
 * MapToggleWrapper — Make.com / Zapier-style variable picker that lets any
 * scalar field mix static text with trigger variables.
 *
 * Behaviour:
 *   • The underlying field renderer (TextField / SelectField / …) always
 *     owns the input — we never replace it with a dropdown. That keeps the
 *     value visible to the user and preserves things like placeholder text
 *     and password masking.
 *   • Next to the label we render a compact "+ Variable" popover. Clicking
 *     an entry APPENDS `{{key}}` to the current string value — the exact
 *     token affiliateService.injectVariables() expands at delivery time.
 *   • Repeated picks keep appending, so users can compose a sentence like
 *     "Hello {{full_name}}, {{phone_number}}" one variable at a time.
 *   • A subtle chip row under the input shows which variables the current
 *     value contains, so the user can see at a glance that their mapping
 *     worked even when the token is scrolled off-screen in a long body.
 *
 * Activation rules (unchanged from the previous iteration):
 *   - `field.mappable: true` on the manifest ConfigField, AND
 *   - The host page passes a non-empty `availableVariables` into DynamicForm.
 * Both missing → the wrapper is a transparent pass-through, so every
 * existing form renders byte-for-byte identically to before.
 */

import * as React from "react";
import { Zap, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ConfigField } from "../types";

export type AvailableVariable = { key: string; label: string };

export interface MapToggleWrapperProps {
  field: ConfigField;
  /** Current value held in the surrounding form state. */
  value: unknown;
  /** Called with the next value — we only ever produce strings. */
  onChange: (next: unknown) => void;
  /** Variable catalogue. Wrapper stays invisible when empty/undefined. */
  availableVariables?: AvailableVariable[];
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
  const hasVariables =
    Array.isArray(availableVariables) && availableVariables.length > 0;

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
    const out = new Map<string, { key: string; label: string }>();
    // Array-ified to avoid the --downlevelIteration requirement on the
    // RegExpStringIterator returned by matchAll on older TS lib targets.
    const matches = Array.from(stringValue.matchAll(TOKEN_RE));
    for (const match of matches) {
      const k = match[1];
      if (out.has(k)) continue;
      const known = availableVariables!.find((v) => v.key === k);
      out.set(k, { key: k, label: known?.label ?? k });
    }
    return Array.from(out.values());
  }, [stringValue, availableVariables]);

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
          variables={availableVariables!}
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
          one {{token}}. Helps users verify their wiring at a glance. */}
      {activeTokens.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {activeTokens.map((t) => (
            <span
              key={t.key}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium"
            >
              <Zap className="h-2.5 w-2.5" strokeWidth={2.5} />
              {t.label}
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

// ─── Variable picker popover ─────────────────────────────────────────────────

function VariablePicker({
  variables,
  onPick,
  disabled,
}: {
  variables: AvailableVariable[];
  onPick: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

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
        className="w-56 p-1"
      >
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Lead variables
        </div>
        <ul className="max-h-72 overflow-auto">
          {variables.map((v) => (
            <li key={v.key}>
              <button
                type="button"
                onClick={() => {
                  onPick(v.key);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left",
                  "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <span className="truncate text-xs font-medium text-foreground">
                  {v.label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {`{{${v.key}}}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

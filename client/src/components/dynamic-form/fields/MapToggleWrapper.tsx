/**
 * MapToggleWrapper — Make.com / Zapier "Map" toggle that lets any scalar
 * field switch between:
 *   • Static mode — the child renderer (TextField / SelectField / ...)
 *     owns the input, user types/picks a literal value.
 *   • Dynamic mode — a variable-picker dropdown replaces the input; the
 *     value becomes `{{<variable-key>}}` so the delivery layer's existing
 *     placeholder expansion (affiliateService.injectVariables) consumes it
 *     byte-for-byte without a separate code path.
 *
 * When NO variables are available (the wizard hasn't connected a trigger,
 * or the host page didn't pass any), the toggle hides itself and this
 * wrapper becomes a transparent pass-through. That keeps every existing
 * DestinationCreatorInline render unchanged — the wrapper is a no-op until
 * a caller opts in by:
 *     a) declaring `mappable: true` on the manifest ConfigField
 *     b) passing `availableVariables` into DynamicForm
 *
 * This is intentionally minimal. A future richer variable picker (grouped
 * by trigger step, searchable, drag-and-drop) can replace the dropdown
 * without touching any other field renderer.
 */

import * as React from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConfigField } from "../types";

export type AvailableVariable = { key: string; label: string };

export interface MapToggleWrapperProps {
  field: ConfigField;
  /** Current value held in the surrounding form state. */
  value: unknown;
  /** Called with the next value whichever mode is active. */
  onChange: (next: unknown) => void;
  /** Variable catalogue. Wrapper stays invisible when empty/undefined. */
  availableVariables?: AvailableVariable[];
  /** The underlying static renderer — TextField / SelectField / … */
  children: React.ReactNode;
  disabled?: boolean;
}

/** A value is "in map mode" when it looks like a single `{{variable}}` token. */
const MAP_PATTERN = /^\{\{\s*([\w.-]+)\s*\}\}$/;

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
  // hasn't supplied variables — guarantees zero visual change for every
  // existing form.
  if (!field.mappable || !hasVariables) {
    return <>{children}</>;
  }

  // Derive current mode from the value shape, NOT from local state — so that
  // navigating away and back keeps the same UI without a stale memory.
  const stringValue = typeof value === "string" ? value : "";
  const match = stringValue.match(MAP_PATTERN);
  const mapMode = match !== null;
  const mappedVariable = mapMode ? match![1] : "";

  const handleToggle = () => {
    if (mapMode) {
      // Leaving map mode — clear the placeholder so the user starts from an
      // empty static input instead of a confusing literal "{{full_name}}".
      onChange("");
    } else {
      // Entering map mode — seed with the first available variable so the
      // input instantly shows SOMETHING valid; the user refines from there.
      const first = availableVariables![0];
      onChange(`{{${first.key}}}`);
    }
  };

  const handleSelectVariable = (nextKey: string) => {
    onChange(`{{${nextKey}}}`);
  };

  return (
    <div className="flex flex-col gap-1.5" data-field-key={field.key}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {field.label}
          {field.required && (
            <span aria-hidden className="ml-0.5 text-destructive">
              *
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={handleToggle}
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
            mapMode
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={mapMode}
          aria-label={`Toggle mapping for ${field.label}`}
        >
          <Zap className="h-3 w-3" strokeWidth={2.5} />
          Map
        </button>
      </div>

      {mapMode ? (
        <select
          value={mappedVariable}
          onChange={(e) => handleSelectVariable(e.target.value)}
          disabled={disabled}
          className={cn(
            "h-10 w-full rounded-md border border-primary/40 bg-primary/5 px-2 text-sm text-primary",
            "focus:outline-none focus:ring-2 focus:ring-primary/30",
          )}
          aria-label={`Variable for ${field.label}`}
        >
          {availableVariables!.map((v) => (
            <option key={v.key} value={v.key}>
              {v.label}
            </option>
          ))}
        </select>
      ) : (
        // Hide the original inline label — we own it above now — while
        // still letting the static renderer own the input element itself.
        <div className="[&>*]:!mt-0 [&_label]:hidden">{children}</div>
      )}

      {field.description && (
        <p className="text-muted-foreground text-xs leading-snug">
          {field.description}
        </p>
      )}
    </div>
  );
}

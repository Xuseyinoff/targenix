/**
 * ConnectionPickerField — manifest adapter around the existing
 * <ConnectionPicker> component.
 *
 * The shared picker already handles fetching, empty-state, "connect new" CTA
 * and stale-selection cleanup. This wrapper just threads the manifest's
 * `connectionType` + label/description into it so the dynamic form engine
 * can treat it like any other field.
 */

import { ConnectionPicker, type ConnectionPickerType as SupportedType } from "@/components/ConnectionPicker";
import { cn } from "@/lib/utils";
import type { BaseFieldProps } from "../types";

// The manifest enum includes "api_key" for future HTTP/custom-auth apps, but
// the shared ConnectionPicker only wires google_sheets + telegram_bot today.
// We narrow here and render a "coming soon" placeholder for types the picker
// cannot yet render — keeps the contract explicit instead of silently passing
// an unsupported value through.
const SUPPORTED_PICKER_TYPES = new Set<SupportedType>(["google_sheets", "telegram_bot"]);

export interface ConnectionPickerFieldProps extends BaseFieldProps {
  value: number | null;
  onChange: (value: number | null) => void;
}

export function ConnectionPickerField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: ConnectionPickerFieldProps) {
  if (!field.connectionType) {
    // A manifest bug: the schema validator in Commit 1 already warns at boot,
    // but render a visible placeholder so a dev poking in DevTools spots it.
    return (
      <div className={cn("text-destructive text-xs", className)}>
        connection-picker field missing `connectionType`.
      </div>
    );
  }

  if (!SUPPORTED_PICKER_TYPES.has(field.connectionType as SupportedType)) {
    return (
      <div
        className={cn("text-muted-foreground text-xs border rounded-md px-3 py-2", className)}
        data-field-key={field.key}
      >
        Connection type "{field.connectionType}" is not yet pickable in the UI.
      </div>
    );
  }

  return (
    <div className={className} data-field-key={field.key}>
      <ConnectionPicker
        type={field.connectionType as SupportedType}
        value={value}
        onChange={onChange}
        label={hideLabel ? undefined : field.label}
        helpText={error ?? field.description}
        required={field.required}
        disabled={disabled}
      />
    </div>
  );
}

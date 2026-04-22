/**
 * ConnectionPickerField — manifest adapter around the existing
 * <ConnectionPicker> component.
 *
 * The shared picker already handles fetching, empty-state, "connect new" CTA
 * and stale-selection cleanup. This wrapper just threads the manifest's
 * `connectionType` + label/description into it so the dynamic form engine
 * can treat it like any other field.
 */

import { Link } from "wouter";
import { KeyRound, ExternalLink } from "lucide-react";
import { ConnectionPicker, type ConnectionPickerType as SupportedType } from "@/components/ConnectionPicker";
import { cn } from "@/lib/utils";
import type { BaseFieldProps } from "../types";

// The manifest enum includes "api_key" for future HTTP/custom-auth apps, but
// the shared ConnectionPicker only wires google_sheets + telegram_bot today.
// For those two types the picker already owns a full inline "+ Connect new"
// flow (OAuth popup / bot-token dialog) so there's nothing extra to build
// here — the widget is Make.com-parity by construction.
//
// For api_key (no manifest app uses it YET — admin templates go through the
// dynamicTemplate adapter and store secrets at destination level) we render
// a bridge card that deep-links to /connections. When the first manifest
// surfaces an api_key field we'll promote that card to a full inline dialog.
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
    // api_key / custom-auth bridge: link into /connections where the user
    // can create an api_key connection against an admin template, then come
    // back. This mirrors Make.com's "create a connection" modal minus the
    // inline dialog — good enough for the zero-adoption path today, and
    // easy to swap for a real inline dialog once a manifest app requires it.
    if (field.connectionType === "api_key") {
      return (
        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5",
            className,
          )}
          data-field-key={field.key}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <KeyRound className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-foreground">
              {field.label}
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Create an API-key connection, then select it here.
            </p>
          </div>
          <Link
            to="/connections"
            className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10"
          >
            Manage
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      );
    }

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

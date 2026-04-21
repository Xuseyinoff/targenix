/**
 * FieldShell — standard outer layout shared by every dynamic field.
 *
 * Renders:
 *   ┌─────────────────────────────────────────────┐
 *   │ Label + (optional "*" for required fields)  │
 *   │ ┌─────────────────────────────────────────┐ │
 *   │ │ children (the actual input widget)      │ │
 *   │ └─────────────────────────────────────────┘ │
 *   │ Description (muted)                          │
 *   │ Error (destructive colour, aria-live)        │
 *   └─────────────────────────────────────────────┘
 *
 * Fields that need their own spacing (e.g. BooleanField puts the label on the
 * right of the switch) can opt out by rendering their own layout instead.
 */

import * as React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { BaseFieldProps } from "../types";

export interface FieldShellProps extends BaseFieldProps {
  /** The input widget. */
  children: React.ReactNode;
  /**
   * html `for=` target. When omitted we fall back to the field key so the
   * label still associates with the first focusable descendant that the
   * child renders with id={field.key}.
   */
  htmlFor?: string;
}

export function FieldShell({
  field,
  error,
  disabled,
  hideLabel,
  className,
  htmlFor,
  children,
}: FieldShellProps) {
  return (
    <div
      className={cn("flex flex-col gap-1.5", disabled && "opacity-70", className)}
      data-field-key={field.key}
    >
      {!hideLabel && (
        <Label
          htmlFor={htmlFor ?? field.key}
          className="text-sm font-medium"
        >
          {field.label}
          {field.required && (
            <span aria-hidden className="text-destructive">
              *
            </span>
          )}
        </Label>
      )}

      {children}

      {field.description && !error && (
        <p className="text-muted-foreground text-xs leading-snug">
          {field.description}
        </p>
      )}

      {error && (
        <p
          className="text-destructive text-xs leading-snug"
          role="alert"
          aria-live="polite"
        >
          {error}
        </p>
      )}
    </div>
  );
}

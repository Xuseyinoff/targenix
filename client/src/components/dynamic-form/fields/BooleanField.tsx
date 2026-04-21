import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { BaseFieldProps } from "../types";

export interface BooleanFieldProps extends BaseFieldProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

/**
 * Inline toggle — label sits on the right of the switch because that scans
 * better than a stacked layout for single-checkbox decisions.
 */
export function BooleanField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: BooleanFieldProps) {
  return (
    <div
      className={cn("flex flex-col gap-1.5", disabled && "opacity-70", className)}
      data-field-key={field.key}
    >
      <div className="flex items-center gap-3">
        <Switch
          id={field.key}
          checked={value}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
        />
        {!hideLabel && (
          <Label htmlFor={field.key} className="cursor-pointer text-sm font-medium">
            {field.label}
            {field.required && (
              <span aria-hidden className="text-destructive">
                *
              </span>
            )}
          </Label>
        )}
      </div>

      {field.description && !error && (
        <p className="text-muted-foreground text-xs leading-snug">{field.description}</p>
      )}

      {error && (
        <p className="text-destructive text-xs leading-snug" role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}

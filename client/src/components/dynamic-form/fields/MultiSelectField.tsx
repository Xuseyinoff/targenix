import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface MultiSelectFieldProps extends BaseFieldProps {
  value: string[];
  onChange: (value: string[]) => void;
}

/**
 * Vertical list of checkboxes, one per field.options[] entry. Kept simple on
 * purpose — popover/chip styles exist in the design system but are reserved
 * for future high-cardinality cases (e.g. tagging). Static options here
 * almost always render ≤10 items.
 */
export function MultiSelectField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: MultiSelectFieldProps) {
  const options = field.options ?? [];
  const toggle = (optValue: string) => {
    if (value.includes(optValue)) {
      onChange(value.filter((v) => v !== optValue));
    } else {
      onChange([...value, optValue]);
    }
  };

  return (
    <FieldShell
      field={field}
      disabled={disabled}
      error={error}
      hideLabel={hideLabel}
      className={className}
    >
      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-md border px-3 py-2",
          "bg-background",
        )}
        role="group"
        aria-labelledby={`${field.key}-label`}
      >
        {options.length === 0 && (
          <span className="text-muted-foreground text-xs">No options available.</span>
        )}
        {options.map((opt) => {
          const id = `${field.key}__${opt.value}`;
          const checked = value.includes(opt.value);
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className="flex items-center gap-2 cursor-pointer select-none"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={() => toggle(opt.value)}
                disabled={disabled}
              />
              <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
                {opt.label}
              </Label>
            </label>
          );
        })}
      </div>
    </FieldShell>
  );
}

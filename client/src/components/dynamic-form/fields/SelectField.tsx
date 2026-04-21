import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface SelectFieldProps extends BaseFieldProps {
  value: string | null;
  onChange: (value: string | null) => void;
}

const CLEAR_SENTINEL = "__clear__";

/**
 * Dropdown backed by the static field.options[] array declared on the
 * manifest. The shadcn Select does not natively support "clear"; we inject a
 * synthetic sentinel row for non-required fields so users can un-pick.
 */
export function SelectField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: SelectFieldProps) {
  const options = field.options ?? [];
  const canClear = !field.required;

  return (
    <FieldShell
      field={field}
      disabled={disabled}
      error={error}
      hideLabel={hideLabel}
      className={className}
      htmlFor={field.key}
    >
      <Select
        value={value ?? ""}
        onValueChange={(next) => {
          if (next === CLEAR_SENTINEL) {
            onChange(null);
            return;
          }
          onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={field.key}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          className="w-full"
        >
          <SelectValue placeholder={field.placeholder ?? "Select…"} />
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
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-muted-foreground text-xs">
              No options available.
            </div>
          )}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

import { Input } from "@/components/ui/input";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface NumberFieldProps extends BaseFieldProps {
  value: number | null;
  onChange: (value: number | null) => void;
}

/**
 * Numeric input that tolerates an empty string (mapped to null so optional
 * numeric fields round-trip cleanly through JSON). Parent forms can apply
 * validation.min / validation.max via the manifest; the field only clamps
 * when both are set to avoid surprising cursor-jumps on partial input.
 */
export function NumberField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: NumberFieldProps) {
  const min = field.validation?.min;
  const max = field.validation?.max;

  return (
    <FieldShell
      field={field}
      disabled={disabled}
      error={error}
      hideLabel={hideLabel}
      className={className}
      htmlFor={field.key}
    >
      <Input
        id={field.key}
        type="number"
        inputMode="numeric"
        value={value == null ? "" : String(value)}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          onChange(parsed);
        }}
        placeholder={field.placeholder}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
      />
    </FieldShell>
  );
}

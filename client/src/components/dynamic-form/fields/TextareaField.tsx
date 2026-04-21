import { Textarea } from "@/components/ui/textarea";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface TextareaFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Monospace font when rendering code / templates. */
  monospace?: boolean;
  rows?: number;
}

export function TextareaField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
  monospace,
  rows = 4,
}: TextareaFieldProps) {
  const maxLength = field.validation?.maxLength;

  return (
    <FieldShell
      field={field}
      disabled={disabled}
      error={error}
      hideLabel={hideLabel}
      className={className}
      htmlFor={field.key}
    >
      <Textarea
        id={field.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
        maxLength={maxLength}
        rows={rows}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
        className={monospace ? "font-mono text-xs" : undefined}
      />
    </FieldShell>
  );
}

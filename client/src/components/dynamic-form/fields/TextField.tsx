import { Input } from "@/components/ui/input";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface TextFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
}

/** Single-line text input. Honours field.placeholder and validation.maxLength. */
export function TextField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: TextFieldProps) {
  const maxLength = field.validation?.maxLength;
  const sensitive = field.sensitive === true;

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
        type={sensitive ? "password" : "text"}
        autoComplete={sensitive ? "off" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
      />
    </FieldShell>
  );
}

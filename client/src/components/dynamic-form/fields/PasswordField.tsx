import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface PasswordFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Masked single-line input with a show/hide toggle. Values are NEVER logged
 * from this component; the toggle lives purely in local state so reveal
 * choices don't leak into the outer form state.
 */
export function PasswordField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
}: PasswordFieldProps) {
  const [revealed, setRevealed] = React.useState(false);
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
      <div className="relative">
        <Input
          id={field.key}
          type={revealed ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          maxLength={maxLength}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          className={cn("pr-10")}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          tabIndex={-1}
          className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
          onClick={() => setRevealed((v) => !v)}
          disabled={disabled}
          aria-label={revealed ? "Hide value" : "Show value"}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>
    </FieldShell>
  );
}

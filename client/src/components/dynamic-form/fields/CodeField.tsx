/**
 * CodeField — monospace multi-line editor for JSON or raw text blobs.
 *
 * This is a minimal implementation on purpose: no syntax highlighting, no
 * Monaco. Targenix already pulls `streamdown` + `@streamdown/code` for the
 * admin pages and adding a full editor here would balloon the bundle and
 * complicate SSR/CSP. If future integrations need rich editing we can swap
 * this file out without touching the form engine.
 */

import { Textarea } from "@/components/ui/textarea";
import { FieldShell } from "./FieldShell";
import type { BaseFieldProps } from "../types";

export interface CodeFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}

export function CodeField({
  field,
  value,
  onChange,
  disabled,
  error,
  hideLabel,
  className,
  rows = 8,
}: CodeFieldProps) {
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
        rows={rows}
        spellCheck={false}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
        className="font-mono text-xs"
      />
    </FieldShell>
  );
}

import { Textarea } from "@/components/ui/textarea";
import { FieldShell } from "./FieldShell";
import { TransformPreviewBadge } from "./TransformPreviewBadge";
import type { BaseFieldProps } from "../types";
import type { EvalContext } from "@shared/transformEngine";

export interface TextareaFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Monospace font when rendering code / templates. */
  monospace?: boolean;
  rows?: number;
  /** Context for real-time transform preview (Make.com-style). */
  previewCtx?: EvalContext;
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
  previewCtx,
}: TextareaFieldProps) {
  const maxLength = field.validation?.maxLength;
  const showPreview = field.showTransformPreview === true;

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
      {showPreview && value && (
        <TransformPreviewBadge template={value} ctx={previewCtx} />
      )}
    </FieldShell>
  );
}

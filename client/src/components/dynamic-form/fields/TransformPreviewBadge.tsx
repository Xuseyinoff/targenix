/**
 * TransformPreviewBadge — Make.com-style inline preview pill.
 *
 * Shows the resolved value of a template expression beneath an input field.
 * Green pill = resolved cleanly. Yellow = unknown variable/function warning.
 * Nothing shown for plain text (no {{ }}) or empty templates.
 */

import { useTransformPreview, SAMPLE_LEAD_CONTEXT } from "@/hooks/useTransformPreview";
import type { EvalContext } from "@shared/transformEngine";

interface Props {
  template: string;
  ctx?: EvalContext;
}

export function TransformPreviewBadge({ template, ctx = SAMPLE_LEAD_CONTEXT }: Props) {
  const { output, unknownVars, unknownFns, hasWarning, isPlain } = useTransformPreview(
    template,
    ctx,
  );

  if (isPlain || !template) return null;

  const label = output.trim() === "" ? "(empty)" : output;
  const warnings = [
    ...unknownVars.map((v) => `unknown variable: ${v}`),
    ...unknownFns.map((f) => `unknown function: ${f}()`),
  ];

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <span
        className={[
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          hasWarning
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
        ].join(" ")}
      >
        <span className="opacity-60">→</span>
        <span className="max-w-[260px] truncate">{label}</span>
      </span>

      {warnings.map((w) => (
        <span
          key={w}
          className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
        >
          ⚠ {w}
        </span>
      ))}
    </div>
  );
}

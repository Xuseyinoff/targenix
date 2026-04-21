/**
 * HiddenField — renders nothing but keeps its declared value in form state.
 *
 * Used for:
 *   - Legacy defaults that must persist in the config blob without being
 *     editable (e.g. a hard-coded adapter version).
 *   - Fields set automatically from elsewhere (computed id, generated tokens).
 *
 * The dynamic form engine still tracks the value — this component just opts
 * out of rendering. A `data-*` placeholder is emitted so DevTools can locate
 * hidden fields when debugging.
 */

import type { BaseFieldProps } from "../types";

export interface HiddenFieldProps extends BaseFieldProps {
  value: unknown;
}

export function HiddenField({ field }: HiddenFieldProps) {
  return <input type="hidden" data-field-key={field.key} data-hidden-field="true" />;
}

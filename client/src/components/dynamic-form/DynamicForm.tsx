/**
 * DynamicForm — root renderer that turns an AppModule.fields[] array into
 * a fully-wired form.
 *
 * Responsibilities:
 *   - Own NO state. Values + errors live on the parent (controlled). This
 *     lets tRPC mutations and Integration wizards own the lifecycle without
 *     fighting the form.
 *   - Dispatch each ConfigField to the right field component from
 *     ./fields/* based on `field.type`.
 *   - Skip fields whose `showWhen` evaluates to false.
 *   - Feed AsyncSelect / FieldMapping the connection id + params derived
 *     from `dependsOn`, so cascading dropdowns "just work".
 *   - Cascade-clear dependent values when a parent field changes, so a
 *     stale sheet tab or mapping never survives a spreadsheet switch.
 *   - Surface per-field errors from the `errors` prop, which the parent
 *     fills by calling `validateFields()` on submit (or can populate with
 *     server-side messages on save failure).
 *
 * What this component does NOT do (yet):
 *   - Variable picker drag-and-drop (planned for a later commit on top of
 *     FieldMapping; the chips we render today are a v0 quick reference).
 *   - File uploads, date pickers, array fields — those field types live
 *     outside `ConfigFieldType` and will be added when a real integration
 *     needs them.
 *   - Submit button / layout chrome. The caller wraps DynamicForm in
 *     whatever shell fits the page (wizard step, dialog, inline editor).
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  AsyncSelectField,
  BooleanField,
  CodeField,
  ConnectionPickerField,
  FieldMappingField,
  HiddenField,
  MultiSelectField,
  NumberField,
  PasswordField,
  SelectField,
  TextField,
  TextareaField,
  type FieldMapping,
} from "./fields";
import type { ConfigField } from "./types";
import {
  collectDependentKeys,
  initialValueForField,
  isFieldVisible,
  type FieldValues,
} from "./validation";

// ─── public API ────────────────────────────────────────────────────────────

export interface DynamicFormProps {
  /** AppManifest module fields, in render order. */
  fields: ConfigField[];
  /** App key for loadOptions calls (async-select / field-mapping). */
  appKey: string;
  /** Current form values, keyed by field.key. Parent-owned. */
  values: FieldValues;
  /** Called with a new `values` object whenever the user edits anything. */
  onChange: (next: FieldValues) => void;
  /**
   * Per-field error messages keyed by field.key. The parent typically fills
   * this from `validateFields(fields, values)` on submit, or from a
   * server-side error response after save.
   */
  errors?: Record<string, string>;
  /** Disable every field (e.g. while saving). */
  disabled?: boolean;
  /**
   * Trigger-time variables available to FieldMapping rows. Forwarded as-is
   * to each FieldMappingField. Typically the lead/trigger schema.
   */
  availableVariables?: Array<{ key: string; label: string }>;
  /** Extra className on the outer container. */
  className?: string;
  /**
   * Name of the field (if any) whose value carries the connectionId that
   * AsyncSelect + FieldMapping should pick up. Defaults to "connectionId"
   * which matches the convention used by built-in manifests (Telegram,
   * Google Sheets). Pass an explicit key here if a future app uses a
   * different convention.
   */
  connectionFieldKey?: string;
}

/** Seed any undefined values with type-appropriate defaults, idempotently. */
export function seedInitialValues(
  fields: ConfigField[],
  existing: FieldValues | undefined,
): FieldValues {
  const next: FieldValues = { ...(existing ?? {}) };
  for (const f of fields) {
    if (next[f.key] === undefined) {
      next[f.key] = initialValueForField(f);
    }
  }
  return next;
}

// ─── component ─────────────────────────────────────────────────────────────

export function DynamicForm({
  fields,
  appKey,
  values,
  onChange,
  errors,
  disabled,
  availableVariables,
  className,
  connectionFieldKey = "connectionId",
}: DynamicFormProps) {
  const connectionIdRaw = values[connectionFieldKey];
  const connectionId =
    typeof connectionIdRaw === "number" && Number.isFinite(connectionIdRaw)
      ? connectionIdRaw
      : null;

  /**
   * When a field changes we:
   *   1. write the new value
   *   2. find all transitively-dependent fields
   *   3. reset them to their initial values — UNLESS the change is a no-op
   *      (user re-selected the same value)
   *
   * This avoids the classic "I picked a new spreadsheet but the old sheet
   * tab is still in the form state" bug. The child field components also
   * prune stale options against their fresh loader data as a second line of
   * defence, but the cascade here makes state transitions predictable.
   */
  const handleFieldChange = React.useCallback(
    (fieldKey: string, newValue: unknown) => {
      const previous = values[fieldKey];
      if (Object.is(previous, newValue)) return;

      const next: FieldValues = { ...values, [fieldKey]: newValue };
      const dependents = collectDependentKeys(fields, fieldKey);
      if (dependents.length > 0) {
        const byKey = new Map(fields.map((f) => [f.key, f]));
        for (const depKey of dependents) {
          const depField = byKey.get(depKey);
          if (!depField) continue;
          next[depKey] = initialValueForField(depField);
        }
      }
      onChange(next);
    },
    [fields, values, onChange],
  );

  /**
   * Extract the subset of `values` that matches a field's `dependsOn` list.
   * Passed to AsyncSelect / FieldMapping so the loader sees exactly the
   * context the manifest asked for — nothing more, nothing less.
   */
  const paramsFor = React.useCallback(
    (field: ConfigField): Record<string, unknown> | undefined => {
      if (!field.dependsOn || field.dependsOn.length === 0) return undefined;
      const out: Record<string, unknown> = {};
      for (const dep of field.dependsOn) {
        if (dep === connectionFieldKey) continue; // passed separately
        out[dep] = values[dep];
      }
      return out;
    },
    [values, connectionFieldKey],
  );

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {fields.map((field) => {
        if (!isFieldVisible(field, values)) return null;

        const error = errors?.[field.key];
        const setValue = (v: unknown) => handleFieldChange(field.key, v);

        // The switch dispatches by field.type. Every field component is
        // strictly controlled, so we can render any of them with the same
        // general wiring and narrow the value type locally.
        switch (field.type) {
          case "text":
            return (
              <TextField
                key={field.key}
                field={field}
                value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "password":
            return (
              <PasswordField
                key={field.key}
                field={field}
                value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "textarea":
            return (
              <TextareaField
                key={field.key}
                field={field}
                value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "code":
            return (
              <CodeField
                key={field.key}
                field={field}
                value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "number": {
            const raw = values[field.key];
            const num = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
            return (
              <NumberField
                key={field.key}
                field={field}
                value={num}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );
          }

          case "boolean":
            return (
              <BooleanField
                key={field.key}
                field={field}
                value={values[field.key] === true}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "select":
            return (
              <SelectField
                key={field.key}
                field={field}
                value={
                  typeof values[field.key] === "string" ? (values[field.key] as string) : null
                }
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "multi-select":
            return (
              <MultiSelectField
                key={field.key}
                field={field}
                value={Array.isArray(values[field.key]) ? (values[field.key] as string[]) : []}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );

          case "async-select":
            return (
              <AsyncSelectField
                key={field.key}
                field={field}
                appKey={appKey}
                value={
                  typeof values[field.key] === "string" ? (values[field.key] as string) : null
                }
                onChange={setValue}
                connectionId={connectionId}
                params={paramsFor(field)}
                error={error}
                disabled={disabled}
              />
            );

          case "connection-picker": {
            const raw = values[field.key];
            const id = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
            return (
              <ConnectionPickerField
                key={field.key}
                field={field}
                value={id}
                onChange={setValue}
                error={error}
                disabled={disabled}
              />
            );
          }

          case "field-mapping":
            return (
              <FieldMappingField
                key={field.key}
                field={field}
                appKey={appKey}
                value={
                  values[field.key] && typeof values[field.key] === "object"
                    ? (values[field.key] as FieldMapping)
                    : {}
                }
                onChange={setValue}
                connectionId={connectionId}
                params={paramsFor(field)}
                error={error}
                disabled={disabled}
                availableVariables={availableVariables}
              />
            );

          case "hidden":
            return (
              <HiddenField key={field.key} field={field} value={values[field.key]} />
            );

          default: {
            // Exhaustiveness guard — adding a new ConfigFieldType without
            // wiring it here will fail at compile time.
            const _exhaustive: never = field.type;
            void _exhaustive;
            return null;
          }
        }
      })}
    </div>
  );
}

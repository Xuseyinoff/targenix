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
  GroupField,
  HiddenField,
  MapToggleWrapper,
  MultiSelectField,
  NumberField,
  PasswordField,
  RepeatableField,
  SelectField,
  TextField,
  TextareaField,
  flattenVariables,
  type AvailableVariable,
  type FieldMapping,
  type RepeatableRowValues,
  type VariableCatalogue,
} from "./fields";
import type { ConfigField } from "./types";
import {
  collectDependentKeys,
  flattenFields,
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
   * Trigger-time variables available to FieldMapping rows AND the per-field
   * Map toggle. Accepts either a legacy flat list OR a grouped tree (Make.com
   * style, e.g. "Lead metadata" + "Field data"). Grouped trees render as a
   * searchable, collapsible picker; flat lists render as a single group.
   */
  availableVariables?: VariableCatalogue;
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

/** Seed any undefined values with type-appropriate defaults, idempotently.
 *
 * Groups are flattened so a child rendered inside an `Advanced settings`
 * collapsible still gets seeded exactly like a top-level sibling. Repeatable
 * fields are seeded once at the top level — their per-row sub-field defaults
 * are applied by RepeatableField when a user clicks "+ Add row".
 */
export function seedInitialValues(
  fields: ConfigField[],
  existing: FieldValues | undefined,
): FieldValues {
  const next: FieldValues = { ...(existing ?? {}) };
  for (const f of flattenFields(fields)) {
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

  // Flat view used by every state-aware helper below. Groups are visual-only,
  // so cascade cleanup and dependency tracking MUST see the children as flat
  // siblings — otherwise a dep declared across the group boundary would never
  // match and we'd leak stale values.
  const flatFields = React.useMemo(() => flattenFields(fields), [fields]);

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
      const dependents = collectDependentKeys(flatFields, fieldKey);
      if (dependents.length > 0) {
        const byKey = new Map(flatFields.map((f) => [f.key, f]));
        for (const depKey of dependents) {
          const depField = byKey.get(depKey);
          if (!depField) continue;
          next[depKey] = initialValueForField(depField);
        }
      }
      onChange(next);
    },
    [flatFields, values, onChange],
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

  // Variable catalogue forwarded to the per-field Map toggle unchanged —
  // the picker itself knows how to render either a flat list or a grouped
  // tree, so we don't normalise here.
  const mapToggleVariables = availableVariables;

  // Legacy `FieldMappingField` (the big 1-row-per-lead-field widget) only
  // needs a flat list of selectable keys, so we flatten any grouped tree
  // into a single array for it. This keeps that component oblivious to the
  // new group shape and avoids touching its internals.
  const flatMappingVariables: AvailableVariable[] | undefined =
    availableVariables && availableVariables.length > 0
      ? flattenVariables(availableVariables)
      : undefined;

  /**
   * Render ONE field. Extracted from the render tree so GroupField can call
   * back into it to render its children without duplicating the dispatch
   * table. Also the place where every scalar renderer is wrapped in
   * MapToggleWrapper — when the manifest opts in AND variables exist, the
   * wrapper swaps the input for a variable picker; otherwise it's a no-op
   * pass-through and existing forms render identically to before.
   */
  const renderField = (field: ConfigField): React.ReactNode => {
    if (!isFieldVisible(field, values)) return null;

    const error = errors?.[field.key];
    const setValue = (v: unknown) => handleFieldChange(field.key, v);

    // Helper: wrap scalar renderers in the Map toggle when opted in. Group,
    // repeatable, field-mapping, connection-picker and hidden are NOT wrapped
    // because "map to a trigger variable" doesn't make sense for them.
    const withMapToggle = (node: React.ReactNode) => (
      <MapToggleWrapper
        field={field}
        value={values[field.key]}
        onChange={setValue}
        availableVariables={mapToggleVariables}
        disabled={disabled}
      >
        {node}
      </MapToggleWrapper>
    );

    // The switch dispatches by field.type. Every field component is
    // strictly controlled, so we can render any of them with the same
    // general wiring and narrow the value type locally.
    switch (field.type) {
      case "text":
        return withMapToggle(
          <TextField
            key={field.key}
            field={field}
            value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
            onChange={setValue}
            error={error}
            disabled={disabled}
          />,
        );

      case "password":
        return withMapToggle(
          <PasswordField
            key={field.key}
            field={field}
            value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
            onChange={setValue}
            error={error}
            disabled={disabled}
          />,
        );

      case "textarea":
        return withMapToggle(
          <TextareaField
            key={field.key}
            field={field}
            value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
            onChange={setValue}
            error={error}
            disabled={disabled}
          />,
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
        return withMapToggle(
          <NumberField
            key={field.key}
            field={field}
            value={num}
            onChange={setValue}
            error={error}
            disabled={disabled}
          />,
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
        return withMapToggle(
          <SelectField
            key={field.key}
            field={field}
            value={
              typeof values[field.key] === "string" ? (values[field.key] as string) : null
            }
            onChange={setValue}
            error={error}
            disabled={disabled}
          />,
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
            availableVariables={flatMappingVariables}
          />
        );

      case "repeatable": {
        const raw = values[field.key];
        const rows = Array.isArray(raw) ? (raw as RepeatableRowValues[]) : [];
        return (
          <RepeatableField
            key={field.key}
            field={field}
            value={rows}
            onChange={setValue}
            error={error}
            disabled={disabled}
          />
        );
      }

      case "group":
        return (
          <GroupField
            key={field.key}
            field={field}
            disabled={disabled}
            renderChild={(child) => renderField(child)}
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
  };

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {fields.map((field) => (
        <React.Fragment key={field.key}>{renderField(field)}</React.Fragment>
      ))}
    </div>
  );
}

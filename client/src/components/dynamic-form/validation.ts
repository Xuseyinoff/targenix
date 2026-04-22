/**
 * Pure validation + visibility logic for the Dynamic Form engine.
 *
 * Kept React-free on purpose: every function here is deterministic, takes
 * plain data, and returns plain data. That makes the rules easy to:
 *   - unit-test (see validation.test.ts — node env, no DOM)
 *   - re-use on the server for a belt-and-braces re-validation before save
 *   - reason about (no hidden state, no effects)
 *
 * Responsibility split inside `dynamic-form/`:
 *   validation.ts   →  given fields + values, produce errors + visibility
 *   DynamicForm.tsx →  own the state, dispatch to field components, wire
 *                      dependency cascades, and surface errors in the UI
 *   fields/*.tsx    →  dumb controlled components, no cross-field logic
 */

import type { ConfigField, ConfigFieldShowWhen } from "./types";

export type FieldValues = Record<string, unknown>;

export interface ValidationResult {
  /** field.key → human-readable error message. Missing keys mean no error. */
  errors: Record<string, string>;
  isValid: boolean;
}

// ─── visibility (showWhen) ─────────────────────────────────────────────────

/**
 * Resolve the showWhen rule against the current form values. Mirrors the
 * three mutually-exclusive forms declared in the manifest:
 *   { equals: X }    → show when values[field] === X
 *   { notEquals: X } → show when values[field] !== X
 *   { in: [X, Y] }   → show when values[field] ∈ list
 *
 * A malformed showWhen (none of the three set) is treated as "always show"
 * — the registry validator warned about it at boot; runtime should stay
 * forgiving rather than hide user inputs silently.
 */
export function evaluateShowWhen(
  rule: ConfigFieldShowWhen,
  values: FieldValues,
): boolean {
  const actual = values[rule.field];

  if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
    return actual === rule.equals;
  }
  if (Object.prototype.hasOwnProperty.call(rule, "notEquals")) {
    return actual !== rule.notEquals;
  }
  if (rule.in !== undefined) {
    return Array.isArray(rule.in) && rule.in.includes(actual);
  }
  // Manifest validator already flagged this; default to visible.
  return true;
}

/** Is this field currently visible given the form state? */
export function isFieldVisible(field: ConfigField, values: FieldValues): boolean {
  if (!field.showWhen) return true;
  return evaluateShowWhen(field.showWhen, values);
}

// ─── value helpers ─────────────────────────────────────────────────────────

/**
 * Is the value "empty" for required-check purposes?
 *   - null / undefined             → empty
 *   - "" / all-whitespace string    → empty
 *   - []                           → empty
 *   - {} (object with no own keys) → empty (used for field-mapping)
 *   - false                        → NOT empty (a real boolean choice)
 *   - 0                            → NOT empty (a real numeric choice)
 */
export function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.keys(value as object).length === 0;
  }
  return false;
}

/**
 * Initial value for a field when it has no stored value yet. Honours
 * `defaultValue` when declared; otherwise returns a type-appropriate blank.
 * The DynamicForm uses this to seed state once on mount.
 */
export function initialValueForField(field: ConfigField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  switch (field.type) {
    case "text":
    case "password":
    case "textarea":
    case "code":
      return "";
    case "number":
      return null;
    case "boolean":
      return false;
    case "select":
    case "async-select":
      return null;
    case "multi-select":
      return [] as string[];
    case "connection-picker":
      return null;
    case "field-mapping":
      return {} as Record<string, string>;
    case "hidden":
      return null;
    case "repeatable":
      // Seed with `minItems` empty rows so the form never renders a
      // required-repeatable as "add something from scratch" — if the admin
      // declared minItems=1 we want at least one pre-filled blank.
      {
        const min = Math.max(0, field.minItems ?? 0);
        if (min === 0 || !Array.isArray(field.itemFields)) return [];
        const row = initialRowForRepeatable(field);
        return Array.from({ length: min }, () => ({ ...row }));
      }
    case "group":
      // Group is a visual container only — it does NOT own a value. Its
      // children live in the top-level values namespace. Returning null
      // keeps the seeder idempotent; DynamicForm is responsible for
      // seeding each child via `seedInitialValues`.
      return null;
    default:
      return null;
  }
}

/**
 * Default record shape for ONE repeatable row — each sub-field seeded via
 * its own `initialValueForField`. Exposed so the RepeatableField component
 * can synthesize new rows on "+ Add" click without duplicating the logic.
 */
export function initialRowForRepeatable(
  field: ConfigField,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const sub of field.itemFields ?? []) {
    row[sub.key] = initialValueForField(sub);
  }
  return row;
}

// ─── validation ────────────────────────────────────────────────────────────

/**
 * Validate one field against its declared rules. Returns a single error
 * message (the first thing that failed) or null when the field passes.
 * String order: required → min/max length → pattern → numeric min/max.
 */
export function validateField(field: ConfigField, value: unknown): string | null {
  // Required first — simpler message, earlier exit.
  if (field.required && isEmptyValue(value)) {
    return `${field.label} is required.`;
  }

  // Subsequent rules only apply when a value IS provided.
  if (isEmptyValue(value)) return null;

  const v = field.validation;
  if (!v) return null;

  // String length bounds (text, password, textarea, code, select value).
  if (typeof value === "string") {
    if (v.minLength != null && value.length < v.minLength) {
      return `${field.label} must be at least ${v.minLength} characters.`;
    }
    if (v.maxLength != null && value.length > v.maxLength) {
      return `${field.label} must be at most ${v.maxLength} characters.`;
    }
    if (v.pattern) {
      try {
        const re = new RegExp(v.pattern);
        if (!re.test(value)) {
          return `${field.label} has an invalid format.`;
        }
      } catch {
        // Malformed regex on the manifest — registry validator already
        // warned. Don't block the user at runtime.
      }
    }
  }

  // Numeric bounds.
  if (typeof value === "number" && Number.isFinite(value)) {
    if (v.min != null && value < v.min) {
      return `${field.label} must be ≥ ${v.min}.`;
    }
    if (v.max != null && value > v.max) {
      return `${field.label} must be ≤ ${v.max}.`;
    }
  }

  return null;
}

/**
 * Validate an entire module's fields at once. Hidden fields (failing
 * showWhen) are skipped — a form should never complain about an input the
 * user cannot see.
 *
 * Recursive rules for the new widgets:
 *   - "group"      — child fields live in the SAME values namespace; we
 *                    just walk them as if they were siblings of the group.
 *   - "repeatable" — each row is validated against the declared itemFields.
 *                    Errors from any row collapse into a single message on
 *                    the repeatable's own key ("Row N: <field> is required")
 *                    so the form can surface one inline hint without
 *                    inventing a nested error schema.
 */
export function validateFields(
  fields: ConfigField[],
  values: FieldValues,
): ValidationResult {
  const errors: Record<string, string> = {};
  walkAndValidate(fields, values, errors);
  return { errors, isValid: Object.keys(errors).length === 0 };
}

function walkAndValidate(
  fields: ConfigField[],
  values: FieldValues,
  errors: Record<string, string>,
): void {
  for (const field of fields) {
    if (!isFieldVisible(field, values)) continue;

    if (field.type === "group") {
      // Visual container only — descend into its children.
      if (Array.isArray(field.groupFields)) {
        walkAndValidate(field.groupFields, values, errors);
      }
      continue;
    }

    if (field.type === "repeatable") {
      const rows = Array.isArray(values[field.key])
        ? (values[field.key] as Array<Record<string, unknown>>)
        : [];
      const min = Math.max(0, field.minItems ?? 0);
      const max = field.maxItems;
      if (field.required && rows.length === 0) {
        errors[field.key] = `${field.label} requires at least one row.`;
        continue;
      }
      if (rows.length < min) {
        errors[field.key] = `${field.label} requires at least ${min} row(s).`;
        continue;
      }
      if (typeof max === "number" && rows.length > max) {
        errors[field.key] = `${field.label} allows at most ${max} row(s).`;
        continue;
      }
      const sub = field.itemFields ?? [];
      // Surface the FIRST invalid sub-field so the user sees where to fix —
      // overwriting on subsequent hits would hide the problem above.
      for (let i = 0; i < rows.length; i += 1) {
        for (const sf of sub) {
          const rowErr = validateField(sf, rows[i]?.[sf.key]);
          if (rowErr) {
            errors[field.key] = `Row ${i + 1}: ${rowErr}`;
            return;
          }
        }
      }
      continue;
    }

    const err = validateField(field, values[field.key]);
    if (err) errors[field.key] = err;
  }
}

// ─── flattening (groups only) ──────────────────────────────────────────────

/**
 * Produce a flat list of logical fields by descending into `group.groupFields`.
 * Groups are visual-only containers (their children share the top-level
 * values namespace) so callers that care about state — seeding, cascade
 * cleanup, connection lookup — should work off the flattened view.
 *
 * Repeatable fields are NOT flattened: their sub-fields live in per-row
 * sub-documents, not the top-level namespace.
 */
export function flattenFields(fields: ConfigField[]): ConfigField[] {
  const out: ConfigField[] = [];
  for (const f of fields) {
    if (f.type === "group" && Array.isArray(f.groupFields)) {
      out.push(...flattenFields(f.groupFields));
      continue;
    }
    out.push(f);
  }
  return out;
}

// ─── dependency cascade ────────────────────────────────────────────────────

/**
 * When `changedKey`'s value changes, find the transitive closure of fields
 * that declare it in `dependsOn` — both directly and via a chain. The
 * DynamicForm resets those to their initial values so the user isn't left
 * with stale selections (e.g. a sheet tab whose parent spreadsheet just
 * changed, or a mapping whose headers no longer exist).
 *
 * Safe against accidental cycles in a manifest — we track visited keys.
 */
export function collectDependentKeys(
  fields: ConfigField[],
  changedKey: string,
): string[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const result = new Set<string>();
  const queue: string[] = [changedKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const f of fields) {
      if (!f.dependsOn?.includes(current)) continue;
      if (result.has(f.key)) continue;
      // guard: a field cannot depend on itself
      if (f.key === changedKey) continue;
      result.add(f.key);
      queue.push(f.key);
    }
  }
  // Preserve original field order in the output for stable clearing.
  return fields.filter((f) => result.has(f.key)).map((f) => f.key).filter((k) => byKey.has(k));
}

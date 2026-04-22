/**
 * Manifest field-schema validation (Commit 1 of Phase 4).
 *
 * Pure data-driven checks run at registry boot. Designed to catch developer
 * mistakes (duplicate keys, missing required metadata, broken dependsOn
 * references) BEFORE the dynamic form engine (Commit 3) tries to render them.
 *
 * These checks are non-throwing by design — they return a list of problems
 * so the caller can decide whether to warn, log, or fail tests. The boot path
 * only warns; unit tests in Commit 1 assert the list is empty for built-in
 * apps.
 */

import type {
  AppManifest,
  AppModule,
  ConfigField,
  ConfigFieldType,
} from "./manifest";

export interface ManifestProblem {
  appKey: string;
  moduleKey?: string;
  fieldKey?: string;
  problem: string;
}

/**
 * Field types whose UI is driven by a runtime loader declared under
 * AppManifest.dynamicOptionsLoaders. Validated at boot so a typo in
 * optionsSource / headersSource fails fast.
 */
const TYPES_REQUIRING_OPTIONS_SOURCE: ReadonlySet<ConfigFieldType> =
  new Set<ConfigFieldType>(["async-select"]);

/** Types that must have a non-empty static options[] array. */
const TYPES_REQUIRING_STATIC_OPTIONS: ReadonlySet<ConfigFieldType> =
  new Set<ConfigFieldType>(["select", "multi-select"]);

/**
 * Validate every module.fields[] array on the manifest and return a flat list
 * of problems. Empty list = manifest is well-formed.
 */
export function validateManifestFields(manifest: AppManifest): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const loaders = manifest.dynamicOptionsLoaders ?? {};

  for (const module of manifest.modules) {
    const fields = module.fields;
    if (!fields || fields.length === 0) continue;

    problems.push(...validateModuleFields(manifest.key, module, fields, loaders));
  }

  return problems;
}

/**
 * Flatten a module's fields: descend into `group.groupFields` so cross-group
 * references in `dependsOn` / `showWhen` are resolvable. Repeatable sub-fields
 * live in their own per-row namespace and are NOT flattened here — they are
 * validated separately below.
 */
function flattenForValidation(fields: ConfigField[]): ConfigField[] {
  const out: ConfigField[] = [];
  for (const f of fields) {
    if (f.type === "group" && Array.isArray(f.groupFields)) {
      out.push(f);
      out.push(...flattenForValidation(f.groupFields));
      continue;
    }
    out.push(f);
  }
  return out;
}

function validateModuleFields(
  appKey: string,
  module: AppModule,
  fields: ConfigField[],
  loaders: Record<string, string>,
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const flatFields = flattenForValidation(fields);
  const allKeys = new Set(flatFields.map((f) => f.key));
  const seenKeys = new Set<string>();

  for (const field of flatFields) {
    const ctx = { appKey, moduleKey: module.key, fieldKey: field.key };

    if (!field.key || typeof field.key !== "string") {
      problems.push({ ...ctx, problem: "field.key must be a non-empty string" });
      continue;
    }
    if (seenKeys.has(field.key)) {
      problems.push({ ...ctx, problem: `duplicate field key '${field.key}'` });
      continue;
    }
    seenKeys.add(field.key);

    if (!field.label || typeof field.label !== "string") {
      problems.push({ ...ctx, problem: "field.label is required" });
    }

    if (TYPES_REQUIRING_STATIC_OPTIONS.has(field.type)) {
      if (!field.options || field.options.length === 0) {
        problems.push({
          ...ctx,
          problem: `type '${field.type}' requires a non-empty options[] array`,
        });
      }
    }

    if (TYPES_REQUIRING_OPTIONS_SOURCE.has(field.type)) {
      if (!field.optionsSource) {
        problems.push({
          ...ctx,
          problem: `type '${field.type}' requires optionsSource`,
        });
      } else if (!loaders[field.optionsSource]) {
        problems.push({
          ...ctx,
          problem: `optionsSource '${field.optionsSource}' is not declared in dynamicOptionsLoaders`,
        });
      }
    }

    if (field.type === "field-mapping") {
      if (!field.headersSource) {
        problems.push({
          ...ctx,
          problem: "type 'field-mapping' requires headersSource",
        });
      } else if (!loaders[field.headersSource]) {
        problems.push({
          ...ctx,
          problem: `headersSource '${field.headersSource}' is not declared in dynamicOptionsLoaders`,
        });
      }
    }

    if (field.type === "connection-picker" && !field.connectionType) {
      problems.push({
        ...ctx,
        problem: "type 'connection-picker' requires connectionType",
      });
    }

    if (field.dependsOn) {
      for (const dep of field.dependsOn) {
        if (dep === field.key) {
          problems.push({ ...ctx, problem: "dependsOn cannot reference the field itself" });
        } else if (!allKeys.has(dep)) {
          problems.push({
            ...ctx,
            problem: `dependsOn references unknown field '${dep}'`,
          });
        }
      }
    }

    if (field.showWhen) {
      if (!allKeys.has(field.showWhen.field)) {
        problems.push({
          ...ctx,
          problem: `showWhen references unknown field '${field.showWhen.field}'`,
        });
      }
      const { equals, notEquals, in: inArr } = field.showWhen;
      const setCount = [equals !== undefined, notEquals !== undefined, inArr !== undefined]
        .filter(Boolean).length;
      if (setCount === 0) {
        problems.push({
          ...ctx,
          problem: "showWhen must set exactly one of equals / notEquals / in",
        });
      }
      if (setCount > 1) {
        problems.push({
          ...ctx,
          problem: "showWhen sets more than one of equals / notEquals / in",
        });
      }
    }

    if (field.validation) {
      const v = field.validation;
      if (v.pattern !== undefined) {
        try {
          new RegExp(v.pattern);
        } catch (err) {
          problems.push({
            ...ctx,
            problem: `validation.pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) {
        problems.push({ ...ctx, problem: "validation.minLength > maxLength" });
      }
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
        problems.push({ ...ctx, problem: "validation.min > max" });
      }
    }

    // ── repeatable ─────────────────────────────────────────────────────────
    // Enforce the "flat nesting" contract: a repeatable's itemFields may NOT
    // themselves be repeatables or groups. The dynamic form engine renders
    // repeatable rows inline — two levels of nesting would produce a UX the
    // schema never intended and make serialization ambiguous.
    if (field.type === "repeatable") {
      const items = field.itemFields;
      if (!Array.isArray(items) || items.length === 0) {
        problems.push({
          ...ctx,
          problem: "type 'repeatable' requires a non-empty itemFields[] array",
        });
      } else {
        const rowKeys = new Set<string>();
        for (const sf of items) {
          if (sf.type === "repeatable" || sf.type === "group") {
            problems.push({
              ...ctx,
              problem: `repeatable.itemFields cannot contain nested '${sf.type}' fields`,
            });
          }
          if (!sf.key || typeof sf.key !== "string") {
            problems.push({
              ...ctx,
              problem: "repeatable.itemFields entry missing key",
            });
            continue;
          }
          if (rowKeys.has(sf.key)) {
            problems.push({
              ...ctx,
              problem: `repeatable row has duplicate key '${sf.key}'`,
            });
          }
          rowKeys.add(sf.key);
        }
      }
      if (
        field.minItems !== undefined &&
        field.maxItems !== undefined &&
        field.minItems > field.maxItems
      ) {
        problems.push({ ...ctx, problem: "repeatable minItems > maxItems" });
      }
    }

    // ── group ──────────────────────────────────────────────────────────────
    // Groups must declare at least one child and must not themselves contain
    // other groups. Keeping nesting flat mirrors Make.com's "Advanced
    // settings" pattern and avoids the indentation spiral that tripped up our
    // first schema-driven forms.
    if (field.type === "group") {
      const children = field.groupFields;
      if (!Array.isArray(children) || children.length === 0) {
        problems.push({
          ...ctx,
          problem: "type 'group' requires a non-empty groupFields[] array",
        });
      } else {
        for (const sf of children) {
          if (sf.type === "group") {
            problems.push({
              ...ctx,
              problem: "group.groupFields cannot contain nested 'group' fields",
            });
          }
        }
      }
    }
  }

  return problems;
}

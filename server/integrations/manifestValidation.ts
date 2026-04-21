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

function validateModuleFields(
  appKey: string,
  module: AppModule,
  fields: ConfigField[],
  loaders: Record<string, string>,
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const allKeys = new Set(fields.map((f) => f.key));
  const seenKeys = new Set<string>();

  for (const field of fields) {
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
  }

  return problems;
}

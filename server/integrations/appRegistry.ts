/**
 * App manifest registry — companion to the adapter registry.
 *
 * - registerApp(manifest) adds an app to the registry and emits a console
 *   warning if its adapterKey is not present in the delivery adapter registry.
 *   The warning is non-fatal because boot order might still be in flight;
 *   see validateAppRegistry() for the strict check used by tests.
 * - listApps() defaults to user-facing (public) apps only; pass
 *   { includeInternal: true } to include legacy/internal entries.
 */

import type { AppManifest, AppCategory } from "./manifest";
import { getAdapter } from "./registry";
import { validateManifestFields, type ManifestProblem } from "./manifestValidation";

const apps = new Map<string, AppManifest>();

export function registerApp(manifest: AppManifest): void {
  if (apps.has(manifest.key)) {
    console.warn(
      `[appRegistry] duplicate registration for app '${manifest.key}' — overwriting.`,
    );
  }
  if (!getAdapter(manifest.adapterKey)) {
    console.warn(
      `[appRegistry] app '${manifest.key}' declares adapterKey='${manifest.adapterKey}' but no adapter is registered under that key. ` +
        `Ensure ./register runs before apps register.`,
    );
  }

  // Commit 1 of Phase 4: warn on malformed field schema but never throw — the
  // delivery path does not consume fields[] yet, so a bad schema must not
  // bring the process down.
  const fieldProblems = validateManifestFields(manifest);
  if (fieldProblems.length > 0) {
    for (const p of fieldProblems) {
      console.warn(
        `[appRegistry] app '${p.appKey}'${p.moduleKey ? ` module '${p.moduleKey}'` : ""}${p.fieldKey ? ` field '${p.fieldKey}'` : ""}: ${p.problem}`,
      );
    }
  }

  apps.set(manifest.key, manifest);
}

export function getApp(key: string): AppManifest | null {
  return apps.get(key) ?? null;
}

export interface ListAppsOptions {
  /** When false (default) internal/legacy apps are filtered out. */
  includeInternal?: boolean;
  category?: AppCategory;
}

export function listApps(options: ListAppsOptions = {}): AppManifest[] {
  const { includeInternal = false, category } = options;
  const result: AppManifest[] = [];
  Array.from(apps.values()).forEach((m) => {
    if (!includeInternal && m.internal) return;
    if (category && m.category !== category) return;
    result.push(m);
  });
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Strict validation helper — returns the list of manifest/adapter mismatches.
 * Intended for unit tests and startup diagnostics, not for hot paths.
 */
export function validateAppRegistry(): Array<{ appKey: string; adapterKey: string }> {
  const problems: Array<{ appKey: string; adapterKey: string }> = [];
  Array.from(apps.values()).forEach((m) => {
    if (!getAdapter(m.adapterKey)) {
      problems.push({ appKey: m.key, adapterKey: m.adapterKey });
    }
  });
  return problems;
}

/**
 * Aggregated field-schema validation across every registered app. Used by the
 * Phase 4 unit tests to assert that every built-in manifest has a well-formed
 * fields[] declaration. Does NOT include adapter mismatches — call
 * validateAppRegistry() for those.
 */
export function validateAllAppFieldSchemas(): ManifestProblem[] {
  const all: ManifestProblem[] = [];
  Array.from(apps.values()).forEach((m) => {
    all.push(...validateManifestFields(m));
  });
  return all;
}

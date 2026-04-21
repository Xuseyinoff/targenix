/**
 * Loader registry — companion of the app and adapter registries.
 *
 * Lookups are keyed by the strings declared in AppManifest.dynamicOptionsLoaders
 * (e.g. "google-sheets.listSpreadsheets"). Registration is idempotent with
 * last-write-wins semantics; tests reset the registry by re-importing.
 */

import type { OptionsLoader } from "./types";

const loaders = new Map<string, OptionsLoader>();

export function registerLoader(key: string, loader: OptionsLoader): void {
  if (loaders.has(key)) {
    console.warn(`[loaderRegistry] duplicate registration for '${key}' — overwriting.`);
  }
  loaders.set(key, loader);
}

export function getLoader(key: string): OptionsLoader | null {
  return loaders.get(key) ?? null;
}

export function listLoaderKeys(): string[] {
  return Array.from(loaders.keys()).sort();
}

/** Test helper — NOT intended for production callers. */
export function __resetLoadersForTests(): void {
  loaders.clear();
}

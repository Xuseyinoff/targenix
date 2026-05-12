import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const REFRESHED_KEY = "tx:lazy-chunk-refreshed";

/**
 * Wraps React.lazy with a one-shot recover-by-reload.
 *
 * Why: after a deploy, an open tab still references chunk hashes from the
 * previous build (e.g. `Leads-3OV6HDIS.js`). Those files no longer exist on
 * the server, so the dynamic import throws `Failed to fetch dynamically
 * imported module`. We reload once to pick up the new `index.html` (and its
 * fresh chunk references). A sessionStorage flag prevents an infinite
 * reload loop if the failure is something other than a stale chunk.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    const alreadyRefreshed =
      window.sessionStorage.getItem(REFRESHED_KEY) === "1";
    try {
      const mod = await factory();
      window.sessionStorage.removeItem(REFRESHED_KEY);
      return mod;
    } catch (err) {
      if (!alreadyRefreshed && isChunkLoadError(err)) {
        window.sessionStorage.setItem(REFRESHED_KEY, "1");
        window.location.reload();
        // Block Suspense while the reload is in flight — never resolves.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}

function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    err.name === "ChunkLoadError"
  );
}

/**
 * appsRouter — Phase 2 of the Make.com-style refactor.
 *
 * Exposes the app manifest registry over tRPC. The frontend will consume
 * `apps.list` in Phase 4 to render destination pickers and dynamic config
 * forms without hardcoded per-type branches. Until then, this endpoint is a
 * cheap read-only metadata feed useful for admin UIs and doc tooling.
 *
 * No adapter invocation, DB access, or credential handling happens here —
 * manifests are plain in-memory objects populated at boot.
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { listApps, getApp } from "../integrations";
import type { AppManifest } from "../integrations";

/**
 * Shape exposed to clients. We intentionally strip `configSchema` for now —
 * Phase 4 will add a dedicated endpoint that returns the schema on demand.
 * This also keeps the payload small and stable while manifests evolve.
 */
function serialize(app: AppManifest) {
  return {
    key: app.key,
    name: app.name,
    version: app.version,
    icon: app.icon ?? null,
    category: app.category,
    description: app.description ?? null,
    connectionType: app.connectionType,
    modules: app.modules,
    availability: app.availability,
  };
}

export const appsRouter = router({
  /**
   * List user-facing apps. Internal/legacy apps (affiliate, legacy-template)
   * are filtered out so the UI never promotes deprecated paths to end users.
   */
  list: protectedProcedure.query(() => {
    return listApps({ includeInternal: false }).map(serialize);
  }),

  /**
   * Look up a single app by key. Returns null for unknown or internal apps
   * so clients can't probe the hidden manifest surface.
   */
  get: protectedProcedure
    .input(z.object({ key: z.string().min(1).max(64) }))
    .query(({ input }) => {
      const app = getApp(input.key);
      if (!app || app.internal) return null;
      return serialize(app);
    }),
});

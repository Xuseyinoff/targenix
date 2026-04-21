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
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { listApps, getApp } from "../integrations";
import type { AppManifest } from "../integrations";
import { getDb } from "../db";
import { checkUserRateLimit } from "../lib/userRateLimit";
import "../integrations/loaders/register";
import { getLoader } from "../integrations/loaders/registry";
import { LoaderValidationError } from "../integrations/loaders/types";

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

  /**
   * Unified dynamic-options endpoint consumed by the DynamicForm (Commit 3).
   *
   * Flow:
   *   1. Validate `appKey` points at a public manifest.
   *   2. Validate `source` is declared in the manifest's
   *      `dynamicOptionsLoaders` so callers can only reach loaders the app
   *      has explicitly opted into.
   *   3. Look up the registered loader implementation and invoke it with a
   *      typed context. Connection ownership is re-checked inside the
   *      loader itself (defence in depth).
   *
   * Errors:
   *   • Unknown app / source              → BAD_REQUEST
   *   • Registered manifest entry missing → INTERNAL_SERVER_ERROR (mis-config)
   *   • LoaderValidationError thrown      → BAD_REQUEST with the loader's msg
   *   • Any other exception               → rethrown; tRPC maps to 500
   */
  loadOptions: protectedProcedure
    .input(
      z.object({
        appKey: z.string().min(1).max(64),
        source: z.string().min(1).max(128),
        connectionId: z.number().int().positive().nullable().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "appsLoadOptions", {
        max: 60,
        windowMs: 60_000,
        message: "Too many option-loader requests. Max 60 per minute.",
      });

      const app = getApp(input.appKey);
      if (!app || app.internal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown app '${input.appKey}'.`,
        });
      }

      const loaderKey = app.dynamicOptionsLoaders?.[input.source];
      if (!loaderKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `App '${input.appKey}' does not declare loader '${input.source}'.`,
        });
      }

      const loader = getLoader(input.source);
      if (!loader) {
        // Manifest says this loader exists but no runtime implementation was
        // registered — a server-side wiring bug, not a client problem.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Loader '${input.source}' is declared on app '${input.appKey}' but not registered. Handler identifier was '${loaderKey}'.`,
        });
      }

      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable.",
        });
      }

      try {
        return await loader({
          userId: ctx.user.id,
          db,
          connectionId: input.connectionId ?? null,
          params: input.params ?? {},
        });
      } catch (err) {
        if (err instanceof LoaderValidationError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
});

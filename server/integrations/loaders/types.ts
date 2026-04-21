/**
 * Shared types for dynamic option loaders (Commit 2 of Phase 4).
 *
 * Each loader returns the data needed to populate ONE dynamic form field at
 * runtime — typically a dropdown of spreadsheets, sheet tabs, pipelines, etc.
 *
 * Loaders are registered by stable string key (matching the keys declared in
 * AppManifest.dynamicOptionsLoaders) and resolved via the loader registry.
 * The appsRouter.loadOptions tRPC endpoint dispatches based on that key.
 */

import type { DbClient } from "../../db";

/**
 * Runtime context passed to every loader. The appsRouter validates the
 * connection (if provided) belongs to the authenticated user BEFORE the
 * loader runs, so implementations can trust `connectionId` points at a row
 * the user owns.
 */
export interface LoadOptionsContext {
  /** Authenticated user id. */
  userId: number;
  /** Live DB client, non-null when the endpoint reaches a loader. */
  db: DbClient;
  /**
   * User-selected connection id from the form state. Null when the field
   * does not depend on a connection (e.g. purely static loaders).
   */
  connectionId: number | null;
  /**
   * Extra parameters supplied by the client — typically values of fields
   * listed in the dependent field's `dependsOn[]`. Validated inside each
   * loader since the shape is loader-specific.
   */
  params: Record<string, unknown>;
}

/** One row in the dropdown produced by a loader. */
export interface LoadOption {
  value: string;
  label: string;
  /** Optional free-form metadata — shown in tooltips or kept for later calls. */
  meta?: Record<string, unknown>;
}

export interface LoadOptionsResult {
  options: LoadOption[];
}

/** Signature every registered loader must conform to. */
export type OptionsLoader = (ctx: LoadOptionsContext) => Promise<LoadOptionsResult>;

/**
 * Thrown by loaders for expected, user-visible failures (missing params,
 * wrong connection type, upstream API error). The tRPC wrapper maps these
 * to BAD_REQUEST with the raw message — so keep messages user-facing.
 */
export class LoaderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoaderValidationError";
  }
}

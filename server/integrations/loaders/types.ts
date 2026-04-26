/**
 * Shared types for the dynamic option loader system.
 *
 * Architecture:
 *   loaderKey (string) → OptionsLoader handler
 *   Registry holds all handlers; appsRouter.loadOptions dispatches to them.
 *   No switch/case, no if/else — pure registry lookup.
 *
 * Make.com / Zapier parity features:
 *   • search       — server-side filtering (avoid loading 1000+ rows)
 *   • cursor       — opaque cursor for keyset/offset pagination
 *   • limit        — max items per page (default 50, max 200)
 *   • hasMore      — tells client whether another page exists
 *   • nextCursor   — opaque token for the next page call
 *   • error codes  — structured codes for safe client-side error handling
 */

import type { DbClient } from "../../db";

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Runtime context injected by appsRouter into every loader call.
 * The router has already validated: auth, rate-limit, app visibility,
 * and that the loaderKey is declared on the app manifest.
 * Loaders must still validate connectionId ownership themselves.
 */
export interface LoadOptionsContext {
  /** Authenticated tenant. */
  userId: number;
  /** Live DB client. */
  db: DbClient;
  /**
   * Connection row id from the form state. Loaders that need external-API
   * credentials must validate ownership before using this.
   */
  connectionId: number | null;
  /**
   * Dependency field values from the form — e.g. `{ spreadsheetId: "1Ab..." }`.
   * Shape is loader-specific; each loader validates what it needs.
   */
  params: Record<string, unknown>;
  /**
   * Optional search/filter string typed by the user in the dropdown.
   * Pass to external API search where supported; otherwise filter locally.
   */
  search?: string;
  /**
   * Opaque pagination cursor returned by a previous call.
   * Undefined means "first page". Loaders that don't support pagination
   * can ignore this and always return the full list.
   */
  cursor?: string;
  /**
   * Maximum number of options to return.
   * appsRouter clamps this to [1, 200]; default is 50.
   */
  limit: number;
}

// ─── Result ──────────────────────────────────────────────────────────────────

/** One row in the dropdown. */
export interface LoadOption {
  value: string;
  label: string;
  /** Optional metadata — kept in form state for dependent loaders. */
  meta?: Record<string, unknown>;
}

export interface LoadOptionsResult {
  options: LoadOption[];
  /**
   * True when more pages are available. Client shows a "Load more" control
   * or automatically fetches the next page (Make.com auto-paginates).
   */
  hasMore?: boolean;
  /**
   * Opaque token to pass as `cursor` in the next request.
   * Only set when hasMore is true.
   */
  nextCursor?: string;
}

/** Signature every registered loader must conform to. */
export type OptionsLoader = (ctx: LoadOptionsContext) => Promise<LoadOptionsResult>;

// ─── Structured errors ────────────────────────────────────────────────────────

/**
 * Error codes returned to the client as safe, structured codes.
 * appsRouter maps these to BAD_REQUEST with { code, message } — never
 * exposing internal stack traces or DB schema details.
 *
 *  CONNECTION_REQUIRED   — field needs a connection; none selected / provided
 *  CONNECTION_INVALID    — connection row not found, wrong type, or inactive
 *  MISSING_PARAM         — a required dependsOn field value is absent
 *  EXTERNAL_API_ERROR    — upstream API returned an error (Sheets, Telegram…)
 *  INVALID_PARAMS        — provided params fail validation
 */
export type LoaderErrorCode =
  | "CONNECTION_REQUIRED"
  | "CONNECTION_INVALID"
  | "MISSING_PARAM"
  | "EXTERNAL_API_ERROR"
  | "INVALID_PARAMS";

/**
 * Thrown by loaders for expected, user-visible failures.
 * appsRouter serialises these to { code, message } — safe for the client.
 * Unexpected errors (DB down, uncaught bug) are rethrown as 500s.
 */
export class LoaderValidationError extends Error {
  readonly code: LoaderErrorCode;

  constructor(message: string, code: LoaderErrorCode = "INVALID_PARAMS") {
    super(message);
    this.name = "LoaderValidationError";
    this.code = code;
  }

  /** Convenience factory — connection row absent or belongs to another user. */
  static connectionRequired(detail?: string): LoaderValidationError {
    return new LoaderValidationError(
      detail ?? "A connection is required — select one first.",
      "CONNECTION_REQUIRED",
    );
  }

  static connectionInvalid(detail: string): LoaderValidationError {
    return new LoaderValidationError(detail, "CONNECTION_INVALID");
  }

  static missingParam(paramName: string): LoaderValidationError {
    return new LoaderValidationError(
      `'${paramName}' is required but was not provided.`,
      "MISSING_PARAM",
    );
  }

  static externalApiError(detail: string): LoaderValidationError {
    return new LoaderValidationError(detail, "EXTERNAL_API_ERROR");
  }
}

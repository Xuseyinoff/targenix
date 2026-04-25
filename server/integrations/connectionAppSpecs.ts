/**
 * Types and helpers for connection app specs. The authoritative data now lives
 * in the `apps` DB table (migration 0048). These types are the shared contract
 * between the DB layer, the validator, and the runtime secret resolver.
 */

/**
 * Connection authentication types.
 *
 * `none` is the auth-less mode used by some Uzbek affiliates whose lead
 * endpoints accept unauthenticated POSTs. A spec with `authType: 'none'`
 * MUST declare `fields: []` (no sensitive fields), and templates pinned
 * to that appKey MUST NOT contain any `{{SECRET:…}}` tokens or
 * `isSecret: true` body fields. Both invariants are enforced by
 * `validateTemplateContract` and by the runtime secret resolver.
 */
export type ConnectionAuthType =
  | "api_key"
  | "oauth2"
  | "bearer"
  | "basic"
  | "none";

export interface ConnectionAppSpecField {
  /** Identifier used inside {{SECRET:key}} tokens and credentialsJson keys. */
  readonly key: string;
  /** Human-readable label rendered in the connection form. */
  readonly label: string;
  /** If true, the user must provide a value before the connection can be saved. */
  readonly required: boolean;
  /**
   * If true, the value is encrypted at rest and templates MUST reference
   * it only via `{{SECRET:<key>}}` — never as a literal string. Enforced
   * by validateTemplateContract.
   */
  readonly sensitive: boolean;
  /** Optional RE2-compatible regex used for client-side and server-side validation. */
  readonly validationRegex?: string;
  /** Optional short help text rendered under the input in the UI. */
  readonly helpText?: string;
}

export interface ConnectionAppSpec {
  readonly appKey: string;
  readonly displayName: string;
  readonly authType: ConnectionAuthType;
  readonly category: "affiliate" | "messaging" | "data" | "webhooks" | "crm";
  readonly fields: readonly ConnectionAppSpecField[];
  readonly iconUrl?: string;
}

/**
 * True when the app spec describes an endpoint that accepts leads without
 * any credentials at all. Callers use this to skip connection lookup,
 * suppress "API key required" UI affordances, and reject templates that
 * try to smuggle a secret token.
 */
export function specIsAuthless(
  spec: Pick<ConnectionAppSpec, "authType" | "fields"> | null | undefined,
): boolean {
  if (!spec) return false;
  if (spec.authType === "none") return true;
  // Defensive: any spec that happens to declare zero sensitive fields is
  // also auth-less for runtime purposes, even if an admin forgot to pick
  // authType='none'. Validator still enforces the explicit form.
  return !spec.fields.some((f) => f.sensitive === true);
}

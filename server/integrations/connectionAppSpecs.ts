/**
 * connectionAppSpecs — source of truth for what credentials each app
 * (affiliate network / messaging service / OAuth provider) requires.
 *
 * Why a TS constant instead of a DB read?
 *
 *   Determinism. The validator runs at admin save time and at server boot.
 *   Both paths must be deterministic and fast; neither can afford a DB
 *   round-trip or a race with mid-flight migrations. Migration 0046
 *   mirrors this constant into the `connection_app_specs` table so the
 *   admin UI and future marketplace can query it, but the authoritative
 *   shape lives here, versioned alongside the code that depends on it.
 *
 * To add a new app:
 *   1. Append a new entry to CONNECTION_APP_SPECS.
 *   2. Add a seed row to the next migration that INSERTs into
 *      connection_app_specs with the same shape.
 *   3. That's it — `validateTemplateContract` and
 *      `validateTemplatesAtBoot` pick it up automatically.
 *
 * Invariant: every key under `fields[]` MUST match the regex
 *   /^[a-z][a-z0-9_]*$/
 * because `SECRET_TOKEN_RE` in validateTemplateContract.ts accepts the
 * same character class. Anything else is caught by the boot validator's
 * structural checks.
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
 * The 5 production affiliate apps. Every entry mirrors a row in
 * migration 0046's seed block. Keep them in sync.
 */
export const CONNECTION_APP_SPECS: readonly ConnectionAppSpec[] = [
  {
    appKey: "alijahon",
    displayName: "Alijahon.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [
      { key: "api_key", label: "API Key", required: true, sensitive: true },
    ],
  },
  {
    appKey: "mgoods",
    displayName: "Mgoods.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [
      { key: "api_key", label: "API Key", required: true, sensitive: true },
    ],
  },
  {
    appKey: "sotuvchi",
    displayName: "Sotuvchi.com",
    authType: "api_key",
    category: "affiliate",
    fields: [
      { key: "api_key", label: "API Key", required: true, sensitive: true },
    ],
  },
  {
    appKey: "inbaza",
    displayName: "Inbaza.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [
      { key: "api_key", label: "API Key", required: true, sensitive: true },
    ],
  },
  {
    appKey: "100k",
    displayName: "100k.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [
      { key: "api_key", label: "API Key", required: true, sensitive: true },
    ],
  },
  {
    // Open affiliate endpoint — any Uzbek affiliate that accepts leads
    // over an unauthenticated POST. No API key, no OAuth, nothing to
    // rotate. Admin templates pinned to this app:
    //   • MUST NOT mark any body field as `isSecret: true`
    //   • MUST NOT reference any `{{SECRET:…}}` token
    //   • Skip the connection step in the integration wizard entirely
    // Validator and runtime both short-circuit on this authType.
    appKey: "open_affiliate",
    displayName: "Open Affiliate (no credentials)",
    authType: "none",
    category: "affiliate",
    fields: [],
  },
] as const;

const SPEC_BY_KEY = new Map<string, ConnectionAppSpec>(
  CONNECTION_APP_SPECS.map((s) => [s.appKey, s]),
);

export function getAppSpec(
  appKey: string | null | undefined,
): ConnectionAppSpec | null {
  if (!appKey) return null;
  return SPEC_BY_KEY.get(appKey) ?? null;
}

export function listAppSpecs(): readonly ConnectionAppSpec[] {
  return CONNECTION_APP_SPECS;
}

export function getAppKeys(): readonly string[] {
  return CONNECTION_APP_SPECS.map((s) => s.appKey);
}

/**
 * Structural self-check of the constant. Runs once at module load so
 * deployment breaks immediately if a developer introduces a malformed
 * entry (duplicate key, field key with bad casing, etc.).
 */
(function assertSpecsWellFormed(): void {
  const APP_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
  const seenAppKeys = new Set<string>();

  for (const spec of CONNECTION_APP_SPECS) {
    if (!APP_KEY_RE.test(spec.appKey)) {
      throw new Error(
        `[connectionAppSpecs] invalid appKey '${spec.appKey}': ` +
          `must match ${APP_KEY_RE}`,
      );
    }
    if (seenAppKeys.has(spec.appKey)) {
      throw new Error(
        `[connectionAppSpecs] duplicate appKey '${spec.appKey}'`,
      );
    }
    seenAppKeys.add(spec.appKey);

    // authType='none' specs are credential-less. Allowing any field would
    // silently undermine the contract, since non-secret fields could still
    // be misread as "credentials" by humans. Keep the invariant tight.
    if (spec.authType === "none" && spec.fields.length > 0) {
      throw new Error(
        `[connectionAppSpecs] app '${spec.appKey}' uses authType='none' ` +
          `but declares ${spec.fields.length} field(s); authType='none' MUST have fields: [].`,
      );
    }

    const seenFieldKeys = new Set<string>();
    for (const field of spec.fields) {
      if (!FIELD_KEY_RE.test(field.key)) {
        throw new Error(
          `[connectionAppSpecs] app '${spec.appKey}' field '${field.key}': ` +
            `key must match ${FIELD_KEY_RE}`,
        );
      }
      if (seenFieldKeys.has(field.key)) {
        throw new Error(
          `[connectionAppSpecs] app '${spec.appKey}' duplicate field key '${field.key}'`,
        );
      }
      seenFieldKeys.add(field.key);
    }
  }
})();

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

/**
 * validateTemplateContract — Stage 1 strict contract between an admin
 * destination template and its connection app spec.
 *
 * The contract rejects, at save time and at server boot:
 *
 *   • templates without an `appKey`
 *   • templates whose `appKey` does not resolve to a known spec
 *   • secret fields (`isSecret: true`) whose value is not EXACTLY
 *     `{{SECRET:<key>}}` (literals like `"sk_live_..."` are rejected)
 *   • `{{SECRET:<key>}}` tokens whose `<key>` is not declared in the
 *     spec with `sensitive: true`
 *   • malformed tokens (wrong casing, punctuation, extra fluff)
 *
 * Non-secret body fields can still contain `{{variable}}` tokens; this
 * validator only looks at the SECRET side of the contract.
 *
 * Spec resolution order (Step B):
 *   1. `specOverride` — pre-loaded by caller (boot efficiency path)
 *   2. `apps` DB table via `resolveSpecSafe` — when `db` is provided
 *   3. TS constant `CONNECTION_APP_SPECS` — temporary fallback until Step C
 *
 * Passing `db` is enough for callers that validate a single template
 * (adminTemplatesRouter). The boot validator passes `specOverride` from a
 * pre-loaded `buildAppSpecMap` to keep boot to one DB round-trip regardless
 * of how many templates are active.
 */

import {
  getAppSpec,
  specIsAuthless,
  type ConnectionAppSpec,
} from "./connectionAppSpecs";
import type { DbClient } from "../db";
import { resolveSpecSafe } from "./listAppsSafe";

/** Value form accepted for a secret field, e.g. `{{SECRET:api_key}}`. */
export const SECRET_TOKEN_RE = /^\{\{\s*SECRET:([a-z][a-z0-9_]*)\s*\}\}$/;

/**
 * Global scan form — same character class as SECRET_TOKEN_RE but
 * designed to find every occurrence within an arbitrary string so we
 * can verify non-secret fields are not smuggling a `{{SECRET:…}}`
 * reference to an undeclared key.
 */
export const SECRET_TOKEN_GLOBAL_RE = /\{\{\s*SECRET:([a-z][a-z0-9_]*)\s*\}\}/g;

export type TemplateBodyField = {
  key: string;
  value: string;
  isSecret?: boolean;
};

export type ValidateTemplateInput = {
  /** Must resolve to an entry in `apps` table, CONNECTION_APP_SPECS, or `specOverride`. */
  appKey: string | null | undefined;
  /** The template's bodyFields array. */
  bodyFields: ReadonlyArray<TemplateBodyField>;
  /**
   * Optional headers map (keyed by header name). Header values use the
   * same `{{SECRET:key}}` grammar as body field values; any reference
   * must resolve to a spec field with `sensitive: true`.
   */
  headers?: Readonly<Record<string, string>> | null;
  /**
   * DB client — when provided the spec is resolved from the `apps` table
   * first (DB-first), falling back to the TS constant. Sufficient for
   * save-time validation (adminTemplatesRouter).
   */
  db?: DbClient | null;
  /**
   * Pre-resolved spec — takes priority over `db` when provided, allowing
   * callers like the boot validator to pre-load all specs in one DB
   * round-trip (via `buildAppSpecMap`) instead of one query per template.
   *
   * Still accepted for backward compatibility. Callers that already have
   * the spec in hand may pass it here to skip the DB lookup.
   */
  specOverride?: ConnectionAppSpec | null;
};

export type TemplateContractErrorCode =
  | "APP_KEY_MISSING"
  | "APP_KEY_UNKNOWN"
  | "SECRET_FIELD_NOT_TOKEN"
  | "SECRET_KEY_UNDECLARED"
  | "SECRET_TOKEN_MALFORMED"
  | "AUTH_NONE_HAS_SECRETS";

/**
 * Domain error thrown by `validateTemplateContract`. Routers convert it
 * into a TRPCError; the boot validator prints it and throws to abort
 * startup. `details` carries the offending field/key so UIs and logs
 * can point to the exact location.
 */
export class TemplateContractError extends Error {
  public readonly code: TemplateContractErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TemplateContractErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TemplateContractError";
    this.code = code;
    this.details = details;
  }
}

async function resolveSpec(
  appKey: string | null | undefined,
  override: ConnectionAppSpec | null | undefined,
  db: DbClient | null | undefined,
): Promise<ConnectionAppSpec> {
  if (typeof appKey !== "string" || appKey.length === 0) {
    throw new TemplateContractError(
      "APP_KEY_MISSING",
      "Template has no appKey — every admin template must belong to a known app.",
      {},
    );
  }
  // Pre-loaded spec wins — caller already did the DB round-trip (boot efficiency path).
  if (override) return override;
  // DB-first: resolveSpecSafe hits `apps` table, falls back to TS constant internally.
  if (db) {
    const spec = await resolveSpecSafe(db, appKey);
    if (spec) return spec;
  }
  // TS constant fallback — used when db is not provided (e.g. unit tests without a DB).
  const spec = getAppSpec(appKey);
  if (!spec) {
    throw new TemplateContractError(
      "APP_KEY_UNKNOWN",
      `App '${appKey}' is not registered. Insert a row into the 'apps' table or pass a \`db\` client.`,
      { appKey },
    );
  }
  return spec;
}

function assertSecretKeyDeclared(
  spec: ConnectionAppSpec,
  secretKey: string,
  where: Readonly<Record<string, unknown>>,
): void {
  const declared = spec.fields.find(
    (f) => f.key === secretKey && f.sensitive === true,
  );
  if (!declared) {
    throw new TemplateContractError(
      "SECRET_KEY_UNDECLARED",
      `Secret key '${secretKey}' is not declared as sensitive in app '${spec.appKey}'.`,
      { appKey: spec.appKey, secretKey, ...where },
    );
  }
}

function validateSecretField(
  spec: ConnectionAppSpec,
  field: TemplateBodyField,
  index: number,
): void {
  const match = SECRET_TOKEN_RE.exec(field.value);
  if (!match) {
    throw new TemplateContractError(
      "SECRET_FIELD_NOT_TOKEN",
      `bodyFields[${index}] key='${field.key}' is marked isSecret but its value is not a {{SECRET:key}} token. ` +
        `Literal secrets are forbidden — reference the connection via {{SECRET:<fieldKey>}}.`,
      { bodyFieldIndex: index, bodyFieldKey: field.key },
    );
  }
  const secretKey = match[1];
  assertSecretKeyDeclared(spec, secretKey, {
    bodyFieldIndex: index,
    bodyFieldKey: field.key,
  });
}

function validateNonSecretSecretReferences(
  spec: ConnectionAppSpec,
  value: string,
  where: Readonly<Record<string, unknown>>,
): void {
  if (!value.includes("{{")) return;

  // If a non-secret field (or header) mentions SECRET:, it still must
  // reference a declared sensitive key. We keep this strict so there is
  // no way to smuggle credentials into a non-secret slot.
  let match: RegExpExecArray | null;
  const re = new RegExp(SECRET_TOKEN_GLOBAL_RE.source, SECRET_TOKEN_GLOBAL_RE.flags);
  while ((match = re.exec(value)) !== null) {
    assertSecretKeyDeclared(spec, match[1], where);
  }

  // Guard against malformed tokens like `{{SECRET:API_KEY}}` or
  // `{{secret:api_key}}` — `{{SECRET:` is present but the strict regex
  // above didn't match. We want that to fail loudly.
  const LOOSE_RE = /\{\{\s*SECRET\s*:\s*[^}]*\}\}/gi;
  let loose: RegExpExecArray | null;
  while ((loose = LOOSE_RE.exec(value)) !== null) {
    const canonical = new RegExp(
      SECRET_TOKEN_GLOBAL_RE.source,
      SECRET_TOKEN_GLOBAL_RE.flags,
    );
    const hit = canonical.exec(loose[0]);
    if (!hit) {
      throw new TemplateContractError(
        "SECRET_TOKEN_MALFORMED",
        `Malformed secret token '${loose[0]}' — tokens must match ${SECRET_TOKEN_RE}.`,
        { appKey: spec.appKey, token: loose[0], ...where },
      );
    }
  }
}

/**
 * Validate a template against its app spec. Throws TemplateContractError
 * on the first violation with a structured `code` + `details`. Returns
 * the resolved spec on success so callers can use it (e.g. to pull
 * field labels).
 *
 * Async since Step B: spec resolution now queries the `apps` DB table
 * when `db` is provided, removing the requirement for callers to
 * pre-resolve via `resolveSpecForValidation` + `specOverride`.
 */
export async function validateTemplateContract(
  input: ValidateTemplateInput,
): Promise<ConnectionAppSpec> {
  const spec = await resolveSpec(input.appKey, input.specOverride, input.db);
  const isAuthless = specIsAuthless(spec);

  input.bodyFields.forEach((field, index) => {
    const value = typeof field.value === "string" ? field.value : "";

    if (isAuthless && field.isSecret === true) {
      throw new TemplateContractError(
        "AUTH_NONE_HAS_SECRETS",
        `App '${spec.appKey}' uses authType='${spec.authType}' (no credentials). ` +
          `bodyFields[${index}] key='${field.key}' is marked isSecret, which is not allowed.`,
        {
          appKey: spec.appKey,
          authType: spec.authType,
          bodyFieldIndex: index,
          bodyFieldKey: field.key,
        },
      );
    }

    if (field.isSecret === true) {
      validateSecretField(spec, field, index);
      return;
    }

    if (isAuthless && value.includes("{{SECRET:")) {
      // Auth-less spec cannot resolve any secret. Reject loudly instead
      // of silently shipping a raw literal at delivery time.
      throw new TemplateContractError(
        "AUTH_NONE_HAS_SECRETS",
        `App '${spec.appKey}' uses authType='${spec.authType}' (no credentials). ` +
          `bodyFields[${index}] key='${field.key}' references a {{SECRET:…}} token, which is not allowed.`,
        {
          appKey: spec.appKey,
          authType: spec.authType,
          bodyFieldIndex: index,
          bodyFieldKey: field.key,
        },
      );
    }

    validateNonSecretSecretReferences(spec, value, {
      bodyFieldIndex: index,
      bodyFieldKey: field.key,
    });
  });

  if (input.headers) {
    for (const [name, value] of Object.entries(input.headers)) {
      const raw = value ?? "";
      if (isAuthless && raw.includes("{{SECRET:")) {
        throw new TemplateContractError(
          "AUTH_NONE_HAS_SECRETS",
          `App '${spec.appKey}' uses authType='${spec.authType}' (no credentials). ` +
            `Header '${name}' references a {{SECRET:…}} token, which is not allowed.`,
          {
            appKey: spec.appKey,
            authType: spec.authType,
            headerName: name,
          },
        );
      }
      validateNonSecretSecretReferences(spec, raw, {
        headerName: name,
      });
    }
  }

  return spec;
}

/** Extract every SECRET key referenced anywhere in a string. */
export function extractSecretKeys(text: string): string[] {
  if (!text) return [];
  const re = new RegExp(
    SECRET_TOKEN_GLOBAL_RE.source,
    SECRET_TOKEN_GLOBAL_RE.flags,
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * validateTemplatesAtBoot — aborts server startup if any active admin
 * template violates the Stage 1 contract.
 *
 * Why at boot?
 *
 *   Save-time validation protects future writes, but pre-existing rows
 *   may have been authored before the validator existed. Running the
 *   same checks at boot guarantees that a running server + a matching
 *   DB agree on the contract — drift is detected before the first
 *   request. A failure here is a loud deploy rollback, not a silent
 *   runtime surprise.
 *
 * Scope:
 *
 *   • Only ACTIVE templates are validated. An admin can still mark a
 *     broken legacy template `isActive = false` and ship the fix
 *     separately without bricking deploy.
 *   • The validator ONLY reads from the DB. It never writes. It never
 *     decrypts. It is safe to run as the very first thing after the
 *     DB pool is ready.
 *
 * Failure:
 *
 *   Throws a single aggregated error listing every failing template.
 *   The caller (_core/index.ts) lets the exception propagate to the
 *   top-level `startServer().catch(console.error)` which aborts with
 *   a non-zero exit code.
 */

import { getDb } from "../db";
import { destinationTemplates } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import {
  validateTemplateContract,
  TemplateContractError,
  type TemplateBodyField,
} from "../integrations/validateTemplateContract";
import { buildAppSpecMap } from "../integrations/listAppsSafe";

type BootTemplateRow = {
  id: number;
  name: string;
  appKey: string | null;
  bodyFields: unknown;
};

type BootFailure = {
  templateId: number;
  templateName: string;
  appKey: string | null;
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
};

export class TemplatesContractBootError extends Error {
  public readonly failures: readonly BootFailure[];
  constructor(failures: readonly BootFailure[]) {
    const head = `[templates-contract] ${failures.length} active template(s) violate the Stage 1 contract:`;
    const body = failures
      .map(
        (f) =>
          `  • id=${f.templateId} "${f.templateName}" appKey=${f.appKey ?? "∅"} ` +
          `→ ${f.code}: ${f.message}`,
      )
      .join("\n");
    super(`${head}\n${body}`);
    this.name = "TemplatesContractBootError";
    this.failures = failures;
  }
}

function normalizeBodyFields(raw: unknown): TemplateBodyField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      key: typeof f.key === "string" ? f.key : "",
      value: typeof f.value === "string" ? f.value : "",
      isSecret: f.isSecret === true,
    }));
}

/**
 * Validate every active admin template against the in-process
 * `CONNECTION_APP_SPECS` constant. Throws `TemplatesContractBootError`
 * listing every failure; throws nothing when all templates are clean.
 *
 * Returns a short summary for the caller to log on success.
 */
export async function validateTemplatesAtBoot(): Promise<{
  ok: true;
  validatedTemplates: number;
  knownApps: number;
}> {
  const db = await getDb();
  if (!db) {
    // No DB — unit tests bootstrapping the router in isolation. Nothing to validate.
    return { ok: true, validatedTemplates: 0, knownApps: 0 };
  }

  // Single round-trip: load all known app specs (TS constant + apps table merged).
  // Avoids N per-row DB queries and ensures templates pinned to DB-only apps
  // (added via admin UI after the last deploy) pass boot validation.
  const specMap = await buildAppSpecMap(db);

  const rows: BootTemplateRow[] = await db
    .select({
      id: destinationTemplates.id,
      name: destinationTemplates.name,
      appKey: destinationTemplates.appKey,
      bodyFields: destinationTemplates.bodyFields,
    })
    .from(destinationTemplates)
    .where(eq(destinationTemplates.isActive, true));

  const failures: BootFailure[] = [];

  for (const row of rows) {
    const bodyFields = normalizeBodyFields(row.bodyFields);
    const specOverride = row.appKey ? specMap.get(row.appKey) : undefined;
    try {
      validateTemplateContract({
        appKey: row.appKey,
        bodyFields,
        specOverride,
      });
    } catch (err) {
      if (err instanceof TemplateContractError) {
        failures.push({
          templateId: row.id,
          templateName: row.name,
          appKey: row.appKey ?? null,
          code: err.code,
          message: err.message,
          details: err.details,
        });
      } else if (err instanceof Error) {
        failures.push({
          templateId: row.id,
          templateName: row.name,
          appKey: row.appKey ?? null,
          code: "UNKNOWN",
          message: err.message,
          details: {},
        });
      } else {
        failures.push({
          templateId: row.id,
          templateName: row.name,
          appKey: row.appKey ?? null,
          code: "UNKNOWN",
          message: "non-error thrown",
          details: {},
        });
      }
    }
  }

  if (failures.length > 0) {
    throw new TemplatesContractBootError(failures);
  }

  return {
    ok: true,
    validatedTemplates: rows.length,
    knownApps: specMap.size,
  };
}

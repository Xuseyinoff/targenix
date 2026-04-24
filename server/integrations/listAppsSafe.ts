/**
 * Read layer: prefer `apps` (migration 0048) when rows exist, else `listAppSpecs()` TS.
 * Does not modify `connection_app_specs` or the constant — reversible by reverting call sites.
 */
import { asc, and, eq } from "drizzle-orm";
import { apps } from "../../drizzle/schema";
import type { AppRow } from "../../drizzle/schema";
import type { DbClient } from "../db";
import {
  type ConnectionAppSpec,
  type ConnectionAppSpecField,
  type ConnectionAuthType,
  getAppSpec,
  listAppSpecs,
} from "./connectionAppSpecs";

const APPS_LOG =
  process.env.STAGE2_APPS_LOG === "1" || process.env.STAGE2_APPS_LOG === "true";

const SPEC_LOG = process.env.STAGE2_SPEC_LOG === "1" || process.env.STAGE2_SPEC_LOG === "true";

function narrowAuthType(raw: string): ConnectionAuthType {
  switch (raw) {
    case "api_key":
    case "oauth2":
    case "bearer":
    case "basic":
    case "none":
      return raw;
    default:
      return "api_key";
  }
}

function narrowCategory(raw: string): ConnectionAppSpec["category"] {
  if (raw === "messaging" || raw === "data" || raw === "webhooks" || raw === "affiliate" || raw === "crm") {
    return raw;
  }
  return "affiliate";
}

function appRowToConnectionAppSpec(row: AppRow): ConnectionAppSpec {
  const rawFields = row.fields;
  const fields: ConnectionAppSpecField[] = Array.isArray(rawFields)
    ? (rawFields as ConnectionAppSpecField[]).map((f) => ({
        key: f.key,
        label: f.label,
        required: f.required,
        sensitive: f.sensitive,
        validationRegex: f.validationRegex,
        helpText: f.helpText,
      }))
    : [];

  return {
    appKey: row.appKey,
    displayName: row.displayName,
    authType: narrowAuthType(String(row.authType)),
    category: narrowCategory(String(row.category)),
    fields,
    iconUrl: row.iconUrl ?? undefined,
  };
}

/**
 * @returns same shape as `listAppSpecs()` in-memory list — for validation/list UIs.
 */
export async function listAppsSafe(db: DbClient): Promise<ConnectionAppSpec[]> {
  try {
    const rows = await db
      .select()
      .from(apps)
      .where(eq(apps.isActive, true))
      .orderBy(asc(apps.appKey));

    if (rows.length > 0) {
      if (APPS_LOG) {
        console.log({ stage: "apps_source", source: "NEW" as const, count: rows.length });
      }
      return rows.map(appRowToConnectionAppSpec);
    }
  } catch (err) {
    if (APPS_LOG) {
      console.warn("[listAppsSafe] DB read failed, falling back to listAppSpecs", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (APPS_LOG) {
    console.log({ stage: "apps_source", source: "LEGACY" as const, count: listAppSpecs().length });
  }
  return [...listAppSpecs()];
}

export type ListAppKeyOption = {
  appKey: string;
  displayName: string;
  authType: string;
  requiresCredentials: boolean;
};

function mapToListKeyOption(s: ConnectionAppSpec): ListAppKeyOption {
  return {
    appKey: s.appKey,
    displayName: s.displayName,
    authType: s.authType,
    requiresCredentials: s.authType !== "none",
  };
}

/**
 * Resolve a spec for a single appKey: TS constant first (fast, deterministic),
 * then `apps` DB table (for apps added via admin UI after the last deploy).
 * Returns null if neither source has the key — never throws.
 */
export async function resolveSpecSafe(
  db: DbClient | null,
  appKey: string | null | undefined,
): Promise<ConnectionAppSpec | null> {
  if (!appKey) return null;
  const tsSpec = getAppSpec(appKey);
  if (tsSpec) {
    if (SPEC_LOG) {
      console.log({ stage: "spec_resolution" as const, source: "TS" as const, appKey });
    }
    return tsSpec;
  }
  if (!db) {
    if (SPEC_LOG) {
      console.log({ stage: "spec_resolution" as const, source: "NONE" as const, appKey });
    }
    return null;
  }
  try {
    const [row] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.appKey, appKey), eq(apps.isActive, true)))
      .limit(1);
    if (row) {
      if (SPEC_LOG) {
        console.log({ stage: "spec_resolution" as const, source: "DB" as const, appKey });
      }
      return appRowToConnectionAppSpec(row);
    }
  } catch {
    // no throw — same as before
  }
  if (SPEC_LOG) {
    console.log({ stage: "spec_resolution" as const, source: "NONE" as const, appKey });
  }
  return null;
}

/** @alias resolveSpecSafe — same contract (TS first, then DB, null if unknown). */
export const resolveSpecForValidation = resolveSpecSafe;

/**
 * Load all active specs into a Map — used by the boot validator to do a
 * single DB round-trip instead of one per template row.
 * Merges TS constant + DB rows; DB wins on conflict (newer data).
 */
export async function buildAppSpecMap(db: DbClient): Promise<Map<string, ConnectionAppSpec>> {
  const specs = await listAppsSafe(db);
  return new Map(specs.map((s) => [s.appKey, s]));
}

/**
 * Picker DTO for admin + connections UIs — same as former `listAppSpecs().map(...)`.
 */
export async function listAppKeyOptionsForPicker(db: DbClient | null): Promise<ListAppKeyOption[]> {
  if (!db) {
    if (APPS_LOG) {
      console.log({ stage: "apps_source", source: "LEGACY" as const, reason: "no_db" });
    }
    return listAppSpecs().map(mapToListKeyOption);
  }
  const specs = await listAppsSafe(db);
  return specs.map(mapToListKeyOption);
}

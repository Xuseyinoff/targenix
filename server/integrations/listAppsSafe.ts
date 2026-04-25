/**
 * Read layer: prefer `apps` (migration 0048) as the sole source of truth.
 * The legacy `connection_app_specs` table and TS constant have been removed
 * (migration 0054 / Step C). All spec data now lives in the `apps` DB table.
 */
import { asc, and, eq } from "drizzle-orm";
import { apps } from "../../drizzle/schema";
import type { AppRow } from "../../drizzle/schema";
import type { DbClient } from "../db";
import {
  type ConnectionAppSpec,
  type ConnectionAppSpecField,
  type ConnectionAuthType,
} from "./connectionAppSpecs";

const APPS_LOG =
  process.env.STAGE2_APPS_LOG === "1" || process.env.STAGE2_APPS_LOG === "true";

function isStage2SpecLog(): boolean {
  return process.env.STAGE2_SPEC_LOG === "1" || process.env.STAGE2_SPEC_LOG === "true";
}

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
 * List all active app specs from the `apps` DB table.
 * Returns an empty array on DB error — callers should treat empty as
 * "no apps configured" and surface an appropriate message.
 */
export async function listAppsSafe(db: DbClient): Promise<ConnectionAppSpec[]> {
  try {
    const rows = await db
      .select()
      .from(apps)
      .where(eq(apps.isActive, true))
      .orderBy(asc(apps.appKey));

    if (APPS_LOG) {
      console.log({ stage: "apps_source", source: "DB" as const, count: rows.length });
    }
    return rows.map(appRowToConnectionAppSpec);
  } catch (err) {
    if (APPS_LOG) {
      console.warn("[listAppsSafe] DB read failed, returning empty list", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
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

type SpecResolutionSource = "DB" | "NONE";

function logSpecSource(source: SpecResolutionSource, appKey: string): void {
  if (!isStage2SpecLog()) return;
  console.log({ stage: "spec_resolution" as const, source, appKey });
}

/**
 * Resolve a spec for a single appKey from the `apps` DB table.
 * Returns null when db is null or no active row is found — never throws.
 */
export async function resolveSpecSafe(
  db: DbClient | null,
  appKey: string | null | undefined,
): Promise<ConnectionAppSpec | null> {
  if (!appKey) return null;

  if (db) {
    try {
      const [row] = await db
        .select()
        .from(apps)
        .where(and(eq(apps.appKey, appKey), eq(apps.isActive, true)))
        .limit(1);
      if (row) {
        logSpecSource("DB", appKey);
        return appRowToConnectionAppSpec(row);
      }
    } catch (err) {
      console.warn("[resolveSpecSafe] DB spec lookup failed:", appKey, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logSpecSource("NONE", appKey);
  return null;
}

/** @alias resolveSpecSafe — same contract (DB only, null if unknown). */
export const resolveSpecForValidation = resolveSpecSafe;

/**
 * Load all active specs into a Map — used by the boot validator to do a
 * single DB round-trip instead of one per template row.
 */
export async function buildAppSpecMap(db: DbClient): Promise<Map<string, ConnectionAppSpec>> {
  const specs = await listAppsSafe(db);
  return new Map(specs.map((s) => [s.appKey, s]));
}

/**
 * Picker DTO for admin + connections UIs.
 */
export async function listAppKeyOptionsForPicker(db: DbClient | null): Promise<ListAppKeyOption[]> {
  if (!db) return [];
  const specs = await listAppsSafe(db);
  return specs.map(mapToListKeyOption);
}

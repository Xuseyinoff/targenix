/**
 * Integration → destination mapping layer (authoritative N:1 join).
 *
 * Owns reads and writes of `integration_destinations`, the table that
 * drives live fan-out dispatch. The legacy `integrations.destinationId`
 * column is kept in parallel via dual-write for rollback safety and as a
 * fallback read source for environments where the multi-destination flag
 * is disabled.
 *
 * Callers:
 *   - `server/db.ts` (createIntegration / updateIntegration) — keeps the
 *     join table in sync with the integration row on every CRUD op.
 *   - `server/routers/integrationsRouter.ts` (testLead) — uses the
 *     resolver to fan-out test leads across all destinations.
 *   - `server/services/leadService.ts` (processLead) — uses the resolver
 *     to fan-out live leads.
 *
 * Error policy:
 *   - Writes are best-effort: failures are logged but NOT rethrown, so a
 *     transient DB glitch cannot break integration CRUD. If drift does
 *     creep in, `tooling/mysql/backfill-integration-destinations.mjs`
 *     reconciles it idempotently.
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db";
import {
  integrationRoutes,
  integrations,
  destinations,
  type Integration,
  type Destination,
} from "../../drizzle/schema";
import type { FilterRule } from "./filterEngine";

export type IntegrationRouteRow = typeof integrationRoutes.$inferSelect;

/**
 * Shape returned by resolveIntegrationRoutes() — each element is
 * one fully-hydrated destination ready for dispatch. We carry the
 * parent mapping row too so later stages (retry tracking, per-destination
 * status) can reference it by id.
 */
export interface ResolvedDestination {
  /** Row in integration_destinations when reading from the new path; null on the legacy path. */
  mappingId: number | null;
  /** Serial number within the integration (0-based). Today always 0. */
  position: number;
  /** Whether this destination is currently enabled (legacy path: always true). */
  enabled: boolean;
  /** Full target_websites row — the dispatcher needs the whole thing. */
  targetWebsite: Destination;
  /** Per-destination filter rule. null = no filter (always deliver). */
  filterJson: FilterRule | null;
}

// ─── public helpers ────────────────────────────────────────────────────────

/**
 * Replace the destination set for one integration.
 *
 * - Runs inside a single transaction so readers never see a torn state
 *   (deleted but not re-inserted, or double entries).
 * - `targetWebsiteIds` preserves order — the array index becomes `position`.
 *   Passing an empty list clears all destinations for the integration.
 * - Dedupes input silently: two identical ids collapse into one row.
 *
 * The helper does NOT verify that the caller owns the integration / target
 * website. That's the job of the outer CRUD endpoint (integrationsRouter).
 */
export async function setIntegrationRoutes(
  db: DbClient,
  integrationId: number,
  targetWebsiteIds: number[],
): Promise<void> {
  if (!Number.isFinite(integrationId) || integrationId <= 0) {
    throw new Error("setIntegrationRoutes: invalid integrationId");
  }

  const ids = dedupe(targetWebsiteIds.filter((n) => Number.isFinite(n) && n > 0));

  await db.transaction(async (tx) => {
    // Wipe the old set. Faster than diffing because:
    //   - destinations-per-integration is tiny (1 today, expected <10).
    //   - we need to preserve ordering; diffing + updating position is more
    //     code than a clean re-insert.
    //   - CASCADE from FK handles the parent delete; this handles edits.
    await tx
      .delete(integrationRoutes)
      .where(eq(integrationRoutes.integrationId, integrationId));

    if (ids.length === 0) return;

    const rows = ids.map((twId, index) => ({
      integrationId,
      destinationId: twId,
      position: index,
      enabled: true,
    }));

    await tx.insert(integrationRoutes).values(rows);
  });
}

/**
 * Convenience wrapper around setIntegrationRoutes() for the legacy
 * 1:1 shape. Use from the existing CRUD code paths until the wizard lands.
 *
 * Passing `null` wipes the destination set — matches the semantics of
 * clearing `integrations.destinationId` in the legacy column.
 */
export async function syncLegacyDestination(
  db: DbClient,
  integrationId: number,
  destinationId: number | null,
): Promise<void> {
  await setIntegrationRoutes(
    db,
    integrationId,
    destinationId == null ? [] : [destinationId],
  );
}

/**
 * Count the current rows in integration_destinations for ONE integration.
 *
 * Used by `updateIntegration` (Stage B data-loss guard): if a caller updates
 * an integration that already has MORE than one destination wired up, we
 * must NOT let the legacy single-id mirror wipe the rest of them. This
 * helper lets the CRUD layer make that call cheaply (one row returned,
 * even for integrations with 20 destinations).
 *
 * Returns 0 for integrations that have never been backfilled — callers can
 * treat `== 0` as "fresh row, mirror is safe".
 */
export async function countIntegrationRoutes(
  db: DbClient,
  integrationId: number,
): Promise<number> {
  if (!Number.isFinite(integrationId) || integrationId <= 0) return 0;
  const rows = await db
    .select({ id: integrationRoutes.id })
    .from(integrationRoutes)
    .where(eq(integrationRoutes.integrationId, integrationId));
  return rows.length;
}

/**
 * Read the current destination set, in position order. Returns an empty
 * array for integrations that have no mapping rows yet.
 */
export async function listIntegrationRoutes(
  db: DbClient,
  integrationId: number,
  options: { onlyEnabled?: boolean } = {},
): Promise<IntegrationRouteRow[]> {
  const where = options.onlyEnabled
    ? and(
        eq(integrationRoutes.integrationId, integrationId),
        eq(integrationRoutes.enabled, true),
      )
    : eq(integrationRoutes.integrationId, integrationId);

  const rows = await db
    .select()
    .from(integrationRoutes)
    .where(where);

  // Stable position-then-id ordering. Drizzle MySQL doesn't compose
  // orderBy with and()-wrapped where cleanly across versions, so we sort
  // in memory; the set is tiny (<10 rows per integration in practice).
  return rows.sort((a, b) => a.position - b.position || a.id - b.id);
}

// ─── read-path resolver ─────────────────────────────────────────────────────

/**
 * Resolve the list of destinations to deliver a lead to for a given
 * integration row. Returns 0 or more `ResolvedDestination` entries,
 * filtered by enabled flag and ownership, in dispatch order.
 *
 * Reads from `integration_routes` joined against `destinations`.
 * Supports N destinations per integration with per-mapping `position`
 * ordering. The legacy single-destination fallback (reading
 * `integrations.destinationId` directly) was removed on 2026-05-12 —
 * a coverage audit confirmed 226/227 active LEAD_ROUTING integrations
 * have valid integration_routes rows.
 *
 * Ownership is enforced: rows whose `destinations.userId` doesn't
 * match the integration's owner are filtered out and logged — they
 * cannot be delivered to safely.
 */
export async function resolveIntegrationRoutes(
  db: DbClient,
  // `destinationId` + `config` are accepted for caller compatibility only —
  // they used to feed the deleted legacy fallback. Safe to drop from the
  // signature on a future refactor that touches every caller.
  integration: Pick<Integration, "id" | "userId" | "destinationId" | "config">,
): Promise<ResolvedDestination[]> {
  // Single query with a JOIN so we fetch target_websites in one round-trip.
  // Sort is done client-side below to keep the SQL dialect-agnostic (the
  // unit tests stub a minimal chain).
  const rows = await db
    .select({
      mapping: integrationRoutes,
      tw: destinations,
    })
    .from(integrationRoutes)
    .innerJoin(
      destinations,
      eq(integrationRoutes.destinationId, destinations.id),
    )
    .where(
      and(
        eq(integrationRoutes.integrationId, integration.id),
        eq(integrationRoutes.enabled, true),
      ),
    );

  const resolved: ResolvedDestination[] = [];
  for (const r of rows) {
    if (r.tw.userId !== integration.userId) {
      // SECURITY: tenant boundary violation — see Sprint 2 / Item 2.3.
      // Should be impossible (dual-write enforces same owner) but a stray
      // row would otherwise leak lead data across tenants — escalate loudly.
      const { log } = await import("./appLogger");
      void log.error(
        "SECURITY",
        "Target website owner mismatch on fan-out resolve",
        {
          integrationId: integration.id,
          mappingId: r.mapping.id,
          destinationId: r.tw.id,
          tenantExpected: integration.userId,
          tenantActual: r.tw.userId,
        },
        null,
        null,
        integration.userId,
        "owner_mismatch",
      );
      continue;
    }
    resolved.push({
      mappingId: r.mapping.id,
      position: r.mapping.position,
      enabled: r.mapping.enabled,
      targetWebsite: r.tw,
      filterJson: (r.mapping.filterJson as FilterRule | null) ?? null,
    });
  }
  resolved.sort((a, b) => a.position - b.position || (a.mappingId ?? 0) - (b.mappingId ?? 0));
  return resolved;
}

// ─── internals ─────────────────────────────────────────────────────────────

function dedupe(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}


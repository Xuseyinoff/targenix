/**
 * Dual-write layer for the integration_destinations table (Commit 4).
 *
 * This module is the single choke-point that keeps the new N:1 join table
 * in sync with the legacy 1:1 `integrations.targetWebsiteId` column. Until
 * Commit 5 flips on dual-read, dispatch still reads the legacy column, so
 * drift here is non-fatal — but we treat it as invariant so the transition
 * later is trivial.
 *
 * Who calls these helpers today:
 *   - server/db.ts          → createIntegration / updateIntegration
 *                             (the canonical CRUD surface used by the tRPC
 *                              router and internal code paths)
 *   - no other callers (yet). When the new Integration wizard lands in
 *     Commit 5 it will call setIntegrationDestinations() directly with a
 *     list of N destinations.
 *
 * Error policy:
 *   - Writes here are best-effort: any failure is logged but NOT rethrown,
 *     so a transient DB glitch on the new table cannot break integration
 *     creation/updates. The backfill script exists precisely to repair
 *     drift if it ever occurs, and dispatch still uses the legacy column.
 *   - This changes in Commit 6 when we make the new table authoritative.
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db";
import {
  integrationDestinations,
  integrations,
  targetWebsites,
  type Integration,
  type TargetWebsite,
} from "../../drizzle/schema";
import { isMultiDestinationsEnabled } from "./featureFlags";

export type IntegrationDestinationRow = typeof integrationDestinations.$inferSelect;

/**
 * Shape returned by resolveIntegrationDestinations() — each element is
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
  targetWebsite: TargetWebsite;
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
export async function setIntegrationDestinations(
  db: DbClient,
  integrationId: number,
  targetWebsiteIds: number[],
): Promise<void> {
  if (!Number.isFinite(integrationId) || integrationId <= 0) {
    throw new Error("setIntegrationDestinations: invalid integrationId");
  }

  const ids = dedupe(targetWebsiteIds.filter((n) => Number.isFinite(n) && n > 0));

  await db.transaction(async (tx) => {
    // Wipe the old set. Faster than diffing because:
    //   - destinations-per-integration is tiny (1 today, expected <10).
    //   - we need to preserve ordering; diffing + updating position is more
    //     code than a clean re-insert.
    //   - CASCADE from FK handles the parent delete; this handles edits.
    await tx
      .delete(integrationDestinations)
      .where(eq(integrationDestinations.integrationId, integrationId));

    if (ids.length === 0) return;

    const rows = ids.map((twId, index) => ({
      integrationId,
      targetWebsiteId: twId,
      position: index,
      enabled: true,
    }));

    await tx.insert(integrationDestinations).values(rows);
  });
}

/**
 * Convenience wrapper around setIntegrationDestinations() for the legacy
 * 1:1 shape. Use from the existing CRUD code paths until the wizard lands.
 *
 * Passing `null` wipes the destination set — matches the semantics of
 * clearing `integrations.targetWebsiteId` in the legacy column.
 */
export async function syncLegacyDestination(
  db: DbClient,
  integrationId: number,
  targetWebsiteId: number | null,
): Promise<void> {
  await setIntegrationDestinations(
    db,
    integrationId,
    targetWebsiteId == null ? [] : [targetWebsiteId],
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
export async function countIntegrationDestinations(
  db: DbClient,
  integrationId: number,
): Promise<number> {
  if (!Number.isFinite(integrationId) || integrationId <= 0) return 0;
  const rows = await db
    .select({ id: integrationDestinations.id })
    .from(integrationDestinations)
    .where(eq(integrationDestinations.integrationId, integrationId));
  return rows.length;
}

/**
 * Read the current destination set, in position order. Safe to call at any
 * time — even before Commit 5 wires dispatch to consume it — because this
 * returns an empty array for integrations not yet backfilled.
 */
export async function listIntegrationDestinations(
  db: DbClient,
  integrationId: number,
  options: { onlyEnabled?: boolean } = {},
): Promise<IntegrationDestinationRow[]> {
  const where = options.onlyEnabled
    ? and(
        eq(integrationDestinations.integrationId, integrationId),
        eq(integrationDestinations.enabled, true),
      )
    : eq(integrationDestinations.integrationId, integrationId);

  const rows = await db
    .select()
    .from(integrationDestinations)
    .where(where);

  // Stable position-then-id ordering. Drizzle MySQL doesn't compose
  // orderBy with and()-wrapped where cleanly across versions, so we sort
  // in memory; the set is tiny (<10 rows per integration in practice).
  return rows.sort((a, b) => a.position - b.position || a.id - b.id);
}

// ─── read-path resolver (Commit 5a) ────────────────────────────────────────

/**
 * Resolve the list of destinations to deliver a lead to, given a parent
 * integration row. The result is a list of 0 or more `ResolvedDestination`
 * entries, already filtered by enabled flag and ownership, in dispatch
 * order.
 *
 * Two backing paths depending on `isMultiDestinationsEnabled(userId)`:
 *
 *   - FLAG OFF (default, today for all users):
 *       Reads the legacy `integrations.targetWebsiteId` column (or its
 *       JSON-config fallback). Returns 0 or 1 destinations. Matches the
 *       exact behaviour of the ad-hoc resolver previously inlined in
 *       leadService.ts — no user-visible change.
 *
 *   - FLAG ON (opt-in users):
 *       Reads from `integration_destinations` joined against
 *       `target_websites`. Today the table holds exactly one row per
 *       integration (after the Commit 4 backfill), so behaviour stays
 *       identical. Commit 5c will add the per-destination tracking
 *       required to safely support N > 1 without risking double-delivery
 *       on retry.
 *
 * Ownership is enforced: rows whose `target_websites.userId` doesn't
 * match the integration's owner are filtered out and logged — these
 * cannot be delivered to safely and used to raise "owner mismatch" in
 * the legacy code path.
 */
export async function resolveIntegrationDestinations(
  db: DbClient,
  integration: Pick<Integration, "id" | "userId" | "targetWebsiteId" | "config">,
): Promise<ResolvedDestination[]> {
  if (isMultiDestinationsEnabled(integration.userId)) {
    return readFromNewTable(db, integration);
  }
  return readFromLegacyColumn(db, integration);
}

async function readFromLegacyColumn(
  db: DbClient,
  integration: Pick<Integration, "id" | "userId" | "targetWebsiteId" | "config">,
): Promise<ResolvedDestination[]> {
  const cfg = (integration.config ?? null) as Record<string, unknown> | null;
  const rawId = integration.targetWebsiteId ?? cfg?.targetWebsiteId;
  const twId =
    typeof rawId === "number" && Number.isFinite(rawId) && rawId > 0 ? rawId
    : typeof rawId === "string" && /^\d+$/.test(rawId) && Number(rawId) > 0 ? Number(rawId)
    : null;
  if (!twId) return [];

  const [row] = await db
    .select()
    .from(targetWebsites)
    .where(eq(targetWebsites.id, twId))
    .limit(1);
  if (!row) return [];
  if (row.userId !== integration.userId) {
    console.warn(
      `[resolveDestinations] owner mismatch on integration=${integration.id} targetWebsite=${row.id}`,
    );
    return [];
  }
  return [
    {
      mappingId: null,
      position: 0,
      enabled: true,
      targetWebsite: row,
    },
  ];
}

async function readFromNewTable(
  db: DbClient,
  integration: Pick<Integration, "id" | "userId">,
): Promise<ResolvedDestination[]> {
  // Single query with a JOIN so we fetch target_websites in one round-trip.
  // Sort is done client-side below to keep the SQL dialect-agnostic (the
  // unit tests stub a minimal chain).
  const rows = await db
    .select({
      mapping: integrationDestinations,
      tw: targetWebsites,
    })
    .from(integrationDestinations)
    .innerJoin(
      targetWebsites,
      eq(integrationDestinations.targetWebsiteId, targetWebsites.id),
    )
    .where(
      and(
        eq(integrationDestinations.integrationId, integration.id),
        eq(integrationDestinations.enabled, true),
      ),
    );

  const resolved: ResolvedDestination[] = [];
  for (const r of rows) {
    if (r.tw.userId !== integration.userId) {
      // This should be impossible in practice (dual-write enforces same
      // owner) but a stray row would otherwise leak lead data cross-tenant.
      console.warn(
        `[resolveDestinations] owner mismatch on integration=${integration.id} mapping=${r.mapping.id} tw=${r.tw.id}`,
      );
      continue;
    }
    resolved.push({
      mappingId: r.mapping.id,
      position: r.mapping.position,
      enabled: r.mapping.enabled,
      targetWebsite: r.tw,
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

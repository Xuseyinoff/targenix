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
import { integrationDestinations } from "../../drizzle/schema";

export type IntegrationDestinationRow = typeof integrationDestinations.$inferSelect;

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

/**
 * destinationPendingQueue.ts — operations on `destination_pending_leads`.
 *
 * Yuboraman parity sprint, PR 4/4 Phase B. Phase A only declared the table;
 * this module is the runtime layer: enqueue at pause, flush at sendHour,
 * force-send on TTL, clean up after destination deletion. The actual
 * per-minute tick that drives these lives in destinationFlushScheduler.ts —
 * keeping the helpers here separate lets the scheduler stay focused on
 * tick orchestration + transitions, and lets tRPC procedures call the
 * helpers directly (e.g. clearSchedule triggers an immediate flush).
 *
 * Feature flag: DESTINATION_SCHEDULES_ENABLED. When unset/false, the
 * pause-check helper `shouldQueueForPause` always returns null, so the
 * normal dispatch path runs unchanged. This lets Phase B deploy with the
 * flag OFF, then flip in production without a redeploy.
 *
 * Payload JSON shape (stored on every pending row):
 *   {
 *     leadPayload:      LeadPayload    // the resolved fullName/phone/email/etc.
 *     integrationId:    number         // for logging + audit trail
 *     integrationConfig: object        // integration.config snapshot — used at flush
 *     variableFields:   object         // per-integration variable overrides
 *     pageName?, formName?, leadCreatedAt? — minimal leadRow snapshot for
 *                                            adapters that read these
 *   }
 * Storing the full context lets the flush dispatch directly via
 * `dispatchDelivery` without re-resolving integration routes.
 *
 * Order-row tracking limitation (Phase B): the normal `deliverOneDestination`
 * path creates an `orders` row keyed by (leadId, integrationId, destinationId)
 * and persists each attempt. The flush path in this module currently
 * BYPASSES that — pending leads have their own audit trail
 * (deliveryError + retryCount + deliveredAt). A follow-up can fold the
 * flush into `deliverOneDestination` with a `bypassScheduleCheck` flag
 * so the order pipeline picks up flushed leads.
 */

import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { DbClient } from "../db";
import {
  destinations,
  destinationSchedules,
  destinationPendingLeads,
  type DestinationSchedule,
  type Destination,
} from "../../drizzle/schema";
import type { LeadPayload } from "./affiliateService";
import { dispatchDelivery } from "../integrations/dispatch";
import { log } from "./appLogger";
import { captureCritical } from "../monitoring/sentry";
import { currentHourInTimezone } from "./destinationFlushScheduler";

/** TTL for queued leads — older than this gets force-sent on the next tick. */
export const STALE_LEAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Returns true when the feature flag is opted-in. Cheap — read every call. */
export function schedulesFeatureFlagOn(): boolean {
  return process.env.DESTINATION_SCHEDULES_ENABLED === "true";
}

/** Shape of the payload snapshot stored on every pending row. */
export interface PendingLeadPayload {
  leadPayload: LeadPayload;
  integrationId: number;
  integrationConfig: Record<string, unknown>;
  variableFields: Record<string, string>;
  /** Minimal leadRow snapshot for adapters (telegram, sheets) that read these. */
  pageName?: string | null;
  formName?: string | null;
  leadCreatedAt?: string;
}

/**
 * Returns the schedule row for a destination, or null when none exists.
 * Centralised here so the dispatch pause-check and the scheduler share
 * the same lookup.
 */
export async function loadDestinationSchedule(
  db: DbClient,
  destinationId: number,
): Promise<DestinationSchedule | null> {
  const [row] = await db
    .select()
    .from(destinationSchedules)
    .where(eq(destinationSchedules.destinationId, destinationId))
    .limit(1);
  return row ?? null;
}

/**
 * Decide whether the dispatch path should queue this lead instead of
 * delivering. Returns the schedule row (so the caller can pass it to
 * `enqueuePendingLead` without re-querying) or null to dispatch normally.
 *
 * No-op when the feature flag is off — the normal dispatch path runs
 * unchanged.
 */
export async function shouldQueueForPause(
  db: DbClient,
  destinationId: number,
): Promise<DestinationSchedule | null> {
  if (!schedulesFeatureFlagOn()) return null;
  const schedule = await loadDestinationSchedule(db, destinationId);
  return schedule && schedule.isPausedNow ? schedule : null;
}

/**
 * Compute the next absolute timestamp at which `sendHour` next occurs in
 * the schedule's timezone. Returns null if `sendHour` is null (lead waits
 * indefinitely, TTL kicks in at 24h).
 *
 * Strategy: probe forward hour-by-hour until we land on a target instant
 * where the wall-clock hour in the schedule's tz matches `sendHour`. Up
 * to 26 hours of probing covers every timezone offset (-12..+14) plus a
 * safety margin. Cheap — 26 Intl.DateTimeFormat calls per queue.
 *
 * Edge cases:
 *   - sendHour = currentHour → returns the NEXT occurrence (tomorrow), not
 *     "right now", since the current sendHour tick has already fired for
 *     this destination (otherwise the lead wouldn't be queueing).
 *   - sendHour = 0 (midnight) → first instant past `now` that's at 00:xx
 *     in the tz.
 */
export function computeNextSendTime(
  schedule: Pick<DestinationSchedule, "sendHour" | "timezone">,
  now: Date = new Date(),
): Date | null {
  if (schedule.sendHour === null) return null;

  // Probe forward in 1-hour steps until we find a future instant where the
  // tz-local hour matches sendHour. Start from now+1h so we never return a
  // moment in the past (or "now") even when the local clock is mid-hour.
  for (let offsetHours = 1; offsetHours <= 26; offsetHours++) {
    const candidate = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
    // Reset to the top of the hour so the queued send-time isn't tied to
    // the minute the lead happened to arrive.
    candidate.setUTCMinutes(0, 0, 0);
    const tzHour = currentHourInTimezone(schedule.timezone, candidate);
    if (tzHour === schedule.sendHour) return candidate;
  }
  // Should be unreachable given offset coverage, but degrade safely.
  return null;
}

/**
 * Persist a lead snapshot to `destination_pending_leads` for later flush.
 * Returns the new row id + computed scheduledFor. Caller is responsible
 * for the early-return in the dispatch path.
 */
export async function enqueuePendingLead(input: {
  db: DbClient;
  destinationId: number;
  leadId: number;
  userId: number;
  payload: PendingLeadPayload;
  schedule: DestinationSchedule;
}): Promise<{ id: number; scheduledFor: Date | null }> {
  const scheduledFor = computeNextSendTime(input.schedule);

  await input.db.insert(destinationPendingLeads).values({
    destinationId: input.destinationId,
    leadId: input.leadId,
    userId: input.userId,
    payload: input.payload as unknown as Record<string, unknown>,
    scheduledFor,
  });

  // Drizzle's MySQL adapter doesn't surface insertId on .values() returning,
  // so look up the row we just wrote — the (destinationId, leadId, NULL deliveredAt)
  // tuple is unique in practice and the read is sub-millisecond.
  const [row] = await input.db
    .select({ id: destinationPendingLeads.id })
    .from(destinationPendingLeads)
    .where(
      and(
        eq(destinationPendingLeads.destinationId, input.destinationId),
        eq(destinationPendingLeads.leadId, input.leadId),
        isNull(destinationPendingLeads.deliveredAt),
      ),
    )
    .orderBy(asc(destinationPendingLeads.id))
    .limit(1);
  const id = row?.id ?? 0;

  void log.info(
    "ORDER",
    "[pendingQueue] Lead queued for scheduled delivery",
    {
      pendingId: id,
      destinationId: input.destinationId,
      leadId: input.leadId,
      scheduledFor: scheduledFor?.toISOString() ?? null,
    },
    input.leadId,
    input.payload.leadPayload.pageId,
    input.userId,
    "destination_paused_queued",
    "system",
  );

  return { id, scheduledFor };
}

/**
 * Dispatch ONE pending row via the same `dispatchDelivery` path the
 * normal flow uses. Returns true on success (caller sets deliveredAt),
 * false on failure (caller records the error + bumps retryCount).
 *
 * Loads the destination row fresh each call to pick up any admin edits
 * since the lead was queued.
 */
async function dispatchOnePending(
  db: DbClient,
  destination: Destination,
  pending: typeof destinationPendingLeads.$inferSelect,
): Promise<{ success: boolean; error?: string }> {
  const payload = pending.payload as unknown as PendingLeadPayload;
  if (!payload?.leadPayload) {
    return { success: false, error: "malformed_payload" };
  }

  const result = await dispatchDelivery(
    {
      db,
      userId: pending.userId,
      integrationType: "LEAD_ROUTING",
      integrationConfig: payload.integrationConfig ?? {},
      targetWebsite: destination,
      leadRow: {
        id: pending.leadId,
        userId: pending.userId,
        pageId: payload.leadPayload.pageId,
        formId: payload.leadPayload.formId,
        pageName: payload.pageName ?? null,
        formName: payload.formName ?? null,
        createdAt: payload.leadCreatedAt ? new Date(payload.leadCreatedAt) : new Date(),
      } as Parameters<typeof dispatchDelivery>[0]["leadRow"],
      variableFields: payload.variableFields ?? {},
    },
    payload.leadPayload,
  );

  if (result.success) return { success: true };
  return { success: false, error: result.error ?? "unknown_dispatch_error" };
}

/**
 * Flush every undelivered pending row for a single destination. Used by:
 *   - the per-minute scheduler at `sendHour` matches
 *   - tRPC procs (clearSchedule, startAll, resetSchedules)
 *
 * Atomic claim: each row is claimed via `UPDATE … SET deliveredAt = NOW()
 * WHERE id = ? AND deliveredAt IS NULL`. If `rowsAffected === 0` a parallel
 * tick (or another replica) already took it — skip without throwing.
 * On dispatch failure the claim is rolled back so the next tick retries.
 *
 * Returns counts for telemetry.
 */
export async function flushPendingForDestination(
  db: DbClient,
  destinationId: number,
): Promise<{ attempted: number; succeeded: number; failed: number; skippedRace: number }> {
  const pending = await db
    .select()
    .from(destinationPendingLeads)
    .where(
      and(
        eq(destinationPendingLeads.destinationId, destinationId),
        isNull(destinationPendingLeads.deliveredAt),
      ),
    )
    .orderBy(asc(destinationPendingLeads.createdAt));

  if (pending.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, skippedRace: 0 };
  }

  // Load the destination ONCE for every row in this batch.
  const [destination] = await db
    .select()
    .from(destinations)
    .where(eq(destinations.id, destinationId))
    .limit(1);

  if (!destination) {
    // Orphan — cleanup loop will mark these on its own. Skip dispatch.
    void log.warn(
      "ORDER",
      "[pendingQueue] destination missing at flush time, skipping",
      { destinationId, pendingCount: pending.length },
    );
    return { attempted: 0, succeeded: 0, failed: 0, skippedRace: 0 };
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedRace = 0;

  for (const row of pending) {
    // Atomic claim. The UPDATE returns affectedRows = 1 when we won the
    // race, 0 when another tick / replica claimed first.
    const claim = await db
      .update(destinationPendingLeads)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          eq(destinationPendingLeads.id, row.id),
          isNull(destinationPendingLeads.deliveredAt),
        ),
      );
    const affected = extractAffectedRows(claim);
    if (affected === 0) {
      skippedRace++;
      continue;
    }

    attempted++;
    try {
      const result = await dispatchOnePending(db, destination, row);
      if (result.success) {
        succeeded++;
        void log.info(
          "ORDER",
          "[pendingQueue] Pending lead delivered",
          { pendingId: row.id, destinationId, leadId: row.leadId },
          row.leadId,
          null,
          row.userId,
          "destination_pending_flushed",
          "system",
        );
      } else {
        failed++;
        // Roll back the claim so the next tick retries.
        await db
          .update(destinationPendingLeads)
          .set({
            deliveredAt: null,
            deliveryError: (result.error ?? "unknown").slice(0, 1000),
            retryCount: sql`${destinationPendingLeads.retryCount} + 1`,
          })
          .where(eq(destinationPendingLeads.id, row.id));
        void log.warn(
          "ORDER",
          "[pendingQueue] Pending lead dispatch failed — claim rolled back",
          {
            pendingId: row.id,
            destinationId,
            leadId: row.leadId,
            error: result.error,
            retryCount: row.retryCount + 1,
          },
          row.leadId,
          null,
          row.userId,
          "destination_pending_failed",
          "system",
        );
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(destinationPendingLeads)
        .set({
          deliveredAt: null,
          deliveryError: message.slice(0, 1000),
          retryCount: sql`${destinationPendingLeads.retryCount} + 1`,
        })
        .where(eq(destinationPendingLeads.id, row.id));
      captureCritical(err, {
        tags: { feature: "destinationPendingQueue", destinationId, pendingId: row.id },
        user: { id: row.userId },
        extra: { leadId: row.leadId },
      });
    }
  }

  if (attempted > 0) {
    void log.info(
      "ORDER",
      "[pendingQueue] Flush batch complete",
      { destinationId, attempted, succeeded, failed, skippedRace },
    );
  }

  return { attempted, succeeded, failed, skippedRace };
}

/**
 * Force-flush every undelivered row older than TTL (24h) regardless of
 * its destination's schedule. Prevents a misconfigured destination from
 * blackholing leads indefinitely.
 *
 * Groups by destinationId so each destination loads once.
 */
export async function flushStalePendingLeads(
  db: DbClient,
  now: Date = new Date(),
): Promise<{ destinations: number; attempted: number; succeeded: number; failed: number }> {
  const cutoff = new Date(now.getTime() - STALE_LEAD_TTL_MS);
  const stale = await db
    .select({ destinationId: destinationPendingLeads.destinationId })
    .from(destinationPendingLeads)
    .where(
      and(
        isNull(destinationPendingLeads.deliveredAt),
        lt(destinationPendingLeads.createdAt, cutoff),
      ),
    );

  if (stale.length === 0) {
    return { destinations: 0, attempted: 0, succeeded: 0, failed: 0 };
  }

  const uniqueDestIds = Array.from(new Set(stale.map((s) => s.destinationId)));
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  for (const destId of uniqueDestIds) {
    // Reuse the per-destination flush; it will pick up the same stale
    // rows since the SELECT inside flushes ALL undelivered for the
    // destination (not just the ones at sendHour). Logging "force-send"
    // intent at this level so audits can spot TTL-driven activity.
    void log.warn(
      "ORDER",
      "[pendingQueue] TTL force-send",
      { destinationId: destId },
    );
    const result = await flushPendingForDestination(db, destId);
    attempted += result.attempted;
    succeeded += result.succeeded;
    failed += result.failed;
  }

  return { destinations: uniqueDestIds.length, attempted, succeeded, failed };
}

/**
 * Mark pending leads whose destination has been hard-deleted as
 * "delivered" with a `deliveryError = "destination_deleted"` marker so
 * the active set stays clean. Prevents the flush loop from re-loading
 * the same orphan rows on every tick.
 */
export async function cleanupOrphanedPending(
  db: DbClient,
): Promise<{ cleaned: number }> {
  // Find pending rows whose destinationId no longer exists.
  // SQL: SELECT pending.id FROM pending LEFT JOIN destinations ON …
  //      WHERE destinations.id IS NULL AND deliveredAt IS NULL
  const orphans = await db
    .select({ id: destinationPendingLeads.id })
    .from(destinationPendingLeads)
    .leftJoin(
      destinations,
      eq(destinationPendingLeads.destinationId, destinations.id),
    )
    .where(
      and(
        isNull(destinations.id),
        isNull(destinationPendingLeads.deliveredAt),
      ),
    );

  if (orphans.length === 0) return { cleaned: 0 };

  const ids = orphans.map((o) => o.id);
  // Drizzle accepts an inArray for the WHERE.
  const { inArray } = await import("drizzle-orm");
  await db
    .update(destinationPendingLeads)
    .set({
      deliveredAt: new Date(),
      deliveryError: "destination_deleted",
    })
    .where(inArray(destinationPendingLeads.id, ids));

  void log.warn(
    "ORDER",
    "[pendingQueue] Cleaned up orphaned pending leads",
    { cleaned: ids.length },
  );

  return { cleaned: ids.length };
}

/**
 * Best-effort helper for tests + ad-hoc tooling. Drizzle's MySQL adapter
 * surfaces the affected row count under a couple of names depending on
 * the result wrapper — try both and degrade to 1 (assume success) when
 * neither shape is present, so production code never throws on a quirky
 * driver version.
 */
function extractAffectedRows(result: unknown): number {
  if (result == null || typeof result !== "object") return 1;
  const r = result as { affectedRows?: number; rowsAffected?: number };
  if (typeof r.affectedRows === "number") return r.affectedRows;
  if (typeof r.rowsAffected === "number") return r.rowsAffected;
  // Drizzle returns [ResultSetHeader, FieldPacket[]] for raw queries.
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as { affectedRows?: number };
    if (typeof first?.affectedRows === "number") return first.affectedRows;
  }
  return 1;
}

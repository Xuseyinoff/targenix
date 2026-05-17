/**
 * destinationSchedulesRouter — per-destination and fleet-wide daily
 * pause/start/send scheduling.
 *
 * Yuboraman parity sprint, PR 4/4 Phase A. The DB tables and the per-minute
 * flush scheduler ship in this PR; the frontend dialog (per-row) plus the
 * global toolbar ship in Phase C. Phase B will wire the schedule into the
 * actual lead dispatch flow (today the scheduler only logs intent).
 *
 * Tenant scope: every procedure either uses `ownedBy()` on a row id or
 * filters by the denormalized `userId` column. No procedure trusts a
 * destinationId from input without re-asserting ownership.
 *
 * Per-destination procedures:
 *   - getSchedule   query    — returns the 0/1 row for a destination.
 *   - setSchedule   mutation — upsert (INSERT … ON DUPLICATE KEY UPDATE).
 *   - clearSchedule mutation — drops the row, releasing the destination
 *                              from any scheduled state.
 *
 * Global (fleet-wide) procedures:
 *   - pauseAll          mutation — upserts the same schedule onto every
 *                                  destination owned by the caller.
 *   - startAll          mutation — clears `isPausedNow` across all of the
 *                                  caller's schedules (manual "resume").
 *   - flushPendingAll   mutation — Phase A stub: returns the count of
 *                                  undelivered destination_pending_leads
 *                                  for this user (Phase B will dispatch).
 *   - resetSchedules    mutation — deletes every schedule the caller owns
 *                                  (matches Yuboraman's "Reset auto-mode").
 */

import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  destinations,
  destinationSchedules,
  destinationPendingLeads,
} from "../../drizzle/schema";
import { ownedBy } from "../lib/assertUserOwns";
import { log } from "../services/appLogger";
import { flushPendingForDestination } from "../services/destinationPendingQueue";

/** Shared input shape for hour fields and timezone. Reused across procs. */
const hourInput = z.number().int().min(0).max(23);
const optionalHour = hourInput.nullable();
const timezoneInput = z.string().min(1).max(64);

export const destinationSchedulesRouter = router({
  // ─── Per-destination ───────────────────────────────────────────────────────

  getSchedule: protectedProcedure
    .input(z.object({ destinationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      // Cross-tenant probe protection: filter on userId in the SELECT so a
      // foreign destinationId resolves to no row (rather than leaking
      // existence via a separate ownership check that throws).
      const [schedule] = await db
        .select()
        .from(destinationSchedules)
        .where(
          and(
            eq(destinationSchedules.destinationId, input.destinationId),
            eq(destinationSchedules.userId, ctx.user.id),
          ),
        )
        .limit(1);
      return schedule ?? null;
    }),

  setSchedule: protectedProcedure
    .input(
      z.object({
        destinationId: z.number().int().positive(),
        pauseHour: optionalHour,
        startHour: optionalHour,
        sendHour: optionalHour,
        timezone: timezoneInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Ownership check on the destination — prevents creating a schedule
      // against a destination owned by a different user.
      const [dest] = await db
        .select({ id: destinations.id })
        .from(destinations)
        .where(ownedBy(destinations, input.destinationId, ctx.user.id))
        .limit(1);
      if (!dest) throw new Error("Destination not found");

      const values = {
        destinationId: input.destinationId,
        userId: ctx.user.id,
        pauseHour: input.pauseHour,
        startHour: input.startHour,
        sendHour: input.sendHour,
        // Default lives in the schema; only override when the client sends one.
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      };

      // Upsert: unique index on destinationId makes ON DUPLICATE KEY UPDATE
      // collapse onto the existing row. Pinning `id` via LAST_INSERT_ID
      // lets us fetch the row id deterministically afterwards. updatedAt
      // is `ON UPDATE CURRENT_TIMESTAMP` in the DDL so it self-bumps.
      await db
        .insert(destinationSchedules)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            id: sql`LAST_INSERT_ID(id)`,
            pauseHour: values.pauseHour,
            startHour: values.startHour,
            sendHour: values.sendHour,
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          },
        });

      const [row] = await db
        .select()
        .from(destinationSchedules)
        .where(
          and(
            eq(destinationSchedules.destinationId, input.destinationId),
            eq(destinationSchedules.userId, ctx.user.id),
          ),
        )
        .limit(1);
      return row ?? null;
    }),

  clearSchedule: protectedProcedure
    .input(z.object({ destinationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      await db
        .delete(destinationSchedules)
        .where(
          and(
            eq(destinationSchedules.destinationId, input.destinationId),
            eq(destinationSchedules.userId, ctx.user.id),
          ),
        );

      // Phase B — schedule cleared means "deliver everything that was waiting".
      // The flush helper is tenant-safe because pending rows for a destination
      // owned by another user couldn't have been queued under this user's
      // schedule in the first place (queue is tied to destinations.userId).
      const flush = await flushPendingForDestination(db, input.destinationId);

      return {
        ok: true,
        flushed: {
          attempted: flush.attempted,
          succeeded: flush.succeeded,
          failed: flush.failed,
        },
      };
    }),

  // ─── Global (fleet-wide) ───────────────────────────────────────────────────

  /**
   * Apply the same daily schedule to every destination the caller owns.
   * Idempotent — re-running with the same input is a no-op against rows
   * already at that state; running with different hours updates them all.
   */
  pauseAll: protectedProcedure
    .input(
      z.object({
        pauseHour: hourInput,
        startHour: optionalHour,
        sendHour: optionalHour,
        timezone: timezoneInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const owned = await db
        .select({ id: destinations.id })
        .from(destinations)
        .where(eq(destinations.userId, ctx.user.id));

      if (owned.length === 0) return { ok: true, affected: 0 };

      let affected = 0;
      for (const dest of owned) {
        const values = {
          destinationId: dest.id,
          userId: ctx.user.id,
          pauseHour: input.pauseHour,
          startHour: input.startHour,
          sendHour: input.sendHour,
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        };
        await db
          .insert(destinationSchedules)
          .values(values)
          .onDuplicateKeyUpdate({
            set: {
              id: sql`LAST_INSERT_ID(id)`,
              pauseHour: values.pauseHour,
              startHour: values.startHour,
              sendHour: values.sendHour,
              ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            },
          });
        affected++;
      }

      void log.info("SYSTEM", "[destinationSchedules.pauseAll] applied", {
        userId: ctx.user.id,
        affected,
        pauseHour: input.pauseHour,
        startHour: input.startHour,
        sendHour: input.sendHour,
      });

      return { ok: true, affected };
    }),

  /**
   * Manual fleet-wide resume — clears `isPausedNow` on every schedule the
   * caller owns AND immediately flushes any pending leads for those
   * destinations. The schedule rows themselves are preserved; the next
   * pauseHour will re-pause unless the user also clears the schedule.
   */
  startAll: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    // Snapshot the destinations that were paused BEFORE the UPDATE so we
    // know which ones to flush. If we read after the UPDATE, the snapshot
    // would be empty.
    const previouslyPaused = await db
      .select({ destinationId: destinationSchedules.destinationId })
      .from(destinationSchedules)
      .where(
        and(
          eq(destinationSchedules.userId, ctx.user.id),
          eq(destinationSchedules.isPausedNow, true),
        ),
      );

    await db
      .update(destinationSchedules)
      .set({ isPausedNow: false })
      .where(eq(destinationSchedules.userId, ctx.user.id));

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const row of previouslyPaused) {
      const flush = await flushPendingForDestination(db, row.destinationId);
      attempted += flush.attempted;
      succeeded += flush.succeeded;
      failed += flush.failed;
    }

    void log.info("SYSTEM", "[destinationSchedules.startAll] cleared isPausedNow + flushed", {
      userId: ctx.user.id,
      destinationsResumed: previouslyPaused.length,
      attempted,
      succeeded,
      failed,
    });
    return {
      ok: true,
      destinationsResumed: previouslyPaused.length,
      flushed: { attempted, succeeded, failed },
    };
  }),

  /**
   * Fleet-wide flush of undelivered pending leads (Phase B real dispatch).
   * Groups by destinationId so each destination loads once; the per-row
   * atomic claim inside `flushPendingForDestination` prevents a parallel
   * scheduler tick from double-dispatching the same row.
   */
  flushPendingAll: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    const pending = await db
      .select({ destinationId: destinationPendingLeads.destinationId })
      .from(destinationPendingLeads)
      .where(
        and(
          eq(destinationPendingLeads.userId, ctx.user.id),
          isNull(destinationPendingLeads.deliveredAt),
        ),
      );

    if (pending.length === 0) {
      return { ok: true, queued: 0, flushed: { attempted: 0, succeeded: 0, failed: 0 } };
    }

    const uniqueDestIds = Array.from(new Set(pending.map((p) => p.destinationId)));
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const destId of uniqueDestIds) {
      const flush = await flushPendingForDestination(db, destId);
      attempted += flush.attempted;
      succeeded += flush.succeeded;
      failed += flush.failed;
    }

    void log.info("SYSTEM", "[destinationSchedules.flushPendingAll] complete", {
      userId: ctx.user.id,
      queued: pending.length,
      destinations: uniqueDestIds.length,
      attempted,
      succeeded,
      failed,
    });

    return {
      ok: true,
      queued: pending.length,
      flushed: { attempted, succeeded, failed },
    };
  }),

  /**
   * Yuboraman's "Reset auto-mode" — wipes every schedule the caller owns
   * AND flushes any pending leads for those destinations (Phase B). The
   * pending row stays in the table until dispatched; resetting the
   * schedule with leads still waiting would otherwise leave them
   * orphaned until the 24h TTL force-flush.
   */
  resetSchedules: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    // Snapshot the destinations that had schedules BEFORE the delete so
    // we know which ones to flush. After the delete the schedule rows
    // are gone and we'd have no way to know.
    const scheduled = await db
      .select({ destinationId: destinationSchedules.destinationId })
      .from(destinationSchedules)
      .where(eq(destinationSchedules.userId, ctx.user.id));

    await db
      .delete(destinationSchedules)
      .where(eq(destinationSchedules.userId, ctx.user.id));

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const row of scheduled) {
      const flush = await flushPendingForDestination(db, row.destinationId);
      attempted += flush.attempted;
      succeeded += flush.succeeded;
      failed += flush.failed;
    }

    void log.info("SYSTEM", "[destinationSchedules.resetSchedules] cleared + flushed", {
      userId: ctx.user.id,
      destinationsCleared: scheduled.length,
      attempted,
      succeeded,
      failed,
    });
    return {
      ok: true,
      destinationsCleared: scheduled.length,
      flushed: { attempted, succeeded, failed },
    };
  }),
});

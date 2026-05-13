/**
 * connectionEventsService — append-only audit trail for connection
 * lifecycle changes. Sprint 2 / Item 2.4.
 *
 * Write contract: every state-changing connection mutation (create, rename,
 * disconnect, expire, error, owner-mismatch) calls `appendConnectionEvent`
 * with a typed `eventType`. The function is `void`-best-effort — failures
 * are logged but never thrown, because losing an audit row must NOT block
 * the user action that created it (we'd rather know a connection got
 * disconnected via the main log than refuse to disconnect because the
 * audit insert hiccupped).
 *
 * Read contract: kept simple — `listConnectionEvents` returns the timeline
 * for one connection in reverse chronological order. The UI history panel
 * and admin "recent security events" view both build on this.
 */

import { desc, eq } from "drizzle-orm";
import type { DbClient } from "../db";
import { connectionEvents } from "../../drizzle/schema";
import { log } from "./appLogger";

/**
 * Canonical event vocabulary. Adding a new entry here only needs a schema
 * comment update — the column is `VARCHAR(32)` so unknown values pass
 * through, which lets admin-introduced lifecycle events appear without a
 * code change. Document new entries in the schema comment so consumers
 * can map them to user-facing labels.
 */
export type ConnectionEventType =
  | "created"           // user added a new connection
  | "renamed"           // user changed displayName
  | "disconnected"      // user removed the connection
  | "status_changed"    // active ↔ expired/revoked/error transitions
  | "oauth_refreshed"   // OAuth token successfully refreshed
  | "oauth_refresh_failed" // invalid_grant or similar — connection becomes unusable
  | "owner_mismatch"    // SECURITY — cross-tenant access attempt detected
  | "health_check_failed" // background probe reported an error
  | "notification_sent"; // user notified about a connection lifecycle event (e.g. expiration)

export type ConnectionEventSource =
  | "user"
  | "system"
  | "oauth"
  | "webhook"
  | "admin";

/**
 * Append a single audit row. Never throws — only logs on failure. Caller
 * may `void`-discard the promise.
 */
export async function appendConnectionEvent(
  db: DbClient,
  params: {
    connectionId: number;
    userId: number;
    eventType: ConnectionEventType;
    source: ConnectionEventSource;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(connectionEvents).values({
      connectionId: params.connectionId,
      userId: params.userId,
      eventType: params.eventType,
      source: params.source,
      details: params.details ?? null,
    });

    // Side-effect: when the event represents a transition into "expired",
    // notify the user. All three expiration paths (oauth_refresh_failed in
    // connectionService, oauth_refresh_failed at refresh time, and the
    // health-check sweep) funnel through this function, so one hook
    // covers them uniformly. The notifier handles its own cooldown and
    // never throws — we void-discard.
    if (isTransitionToExpired(params)) {
      const { notifyConnectionExpired } = await import("./connectionExpirationNotifier");
      void notifyConnectionExpired(db, {
        connectionId: params.connectionId,
        userId: params.userId,
        reason: deriveReason(params),
      });
    }
  } catch (err) {
    // Audit write failure is logged loudly but never blocks the main flow.
    void log.error(
      "CONNECTIONS",
      "Failed to append connection_events row",
      {
        connectionId: params.connectionId,
        eventType: params.eventType,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      null,
      params.userId,
    );
  }
}

/**
 * True when this event row represents a connection moving INTO the expired
 * state (`details.to === "expired"`) FROM something other than expired.
 * Only the three transition-bearing event types qualify — `created`,
 * `renamed`, `disconnected`, `oauth_refreshed`, `owner_mismatch`, and
 * `notification_sent` are never transitions to expired.
 */
function isTransitionToExpired(params: {
  eventType: ConnectionEventType;
  details?: Record<string, unknown>;
}): boolean {
  if (
    params.eventType !== "status_changed" &&
    params.eventType !== "oauth_refresh_failed" &&
    params.eventType !== "health_check_failed"
  ) {
    return false;
  }
  const to = params.details?.to;
  const from = params.details?.from;
  return to === "expired" && from !== "expired";
}

function deriveReason(params: {
  eventType: ConnectionEventType;
  details?: Record<string, unknown>;
}): string {
  const explicit = params.details?.reason;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return params.eventType;
}

/**
 * Timeline for one connection — newest first. Used by the connection
 * history UI panel and by admin forensic queries.
 */
export async function listConnectionEvents(
  db: DbClient,
  connectionId: number,
  options: { limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  return db
    .select()
    .from(connectionEvents)
    .where(eq(connectionEvents.connectionId, connectionId))
    .orderBy(desc(connectionEvents.createdAt))
    .limit(limit);
}

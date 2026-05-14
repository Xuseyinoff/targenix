/**
 * requestContext — request-scoped state propagated through async call chains
 * via Node's AsyncLocalStorage.
 *
 * Roadmap #7. The original motivation is correlation: when an admin debugs
 * "what happened with lead X", they currently have to piece together rows
 * across `app_logs`, `orders`, and Sentry by lead id and timestamp. With a
 * trace id stamped on every log line emitted during one unit of work
 * (incoming HTTP request, scheduler tick, or worker job), `LIKE '%traceId%'`
 * against `app_logs.meta` returns the entire story.
 *
 * Design choices:
 *   - One ALS instance, lazily created on first import. Tests can call
 *     `runWithRequestContext` directly without spinning up Express.
 *   - Context shape is intentionally minimal — `{ traceId, kind, name? }`.
 *     Anything richer (user id, lead id, etc.) belongs in the per-log
 *     `meta` payload, not in the ambient context, so the tree of nested
 *     calls doesn't accidentally inherit stale state.
 *   - `getTraceId()` returns undefined when there is no active context
 *     instead of throwing — this is called from low-level helpers
 *     (appLogger) that must keep working in non-request contexts
 *     (e.g. boot-time SDK calls).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TraceKind = "http" | "scheduler" | "worker" | "webhook";

export interface RequestContext {
  /** Globally unique within a reasonable time window. Stamped on every
   *  log line emitted inside the run scope. */
  traceId: string;
  /** Coarse classification so admins can filter "show all scheduler runs". */
  kind: TraceKind;
  /** Optional human-readable name — e.g. "orderRetry" for a scheduler tick,
   *  "lead-processing" for a BullMQ worker. */
  name?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside a request context. All async operations spawned
 * inside `fn` inherit the context until they settle.
 */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

// ─── Trace id factories ─────────────────────────────────────────────────────
//
// Trace ids are prefixed by kind so a human eyeballing app_logs can tell at
// a glance whether a row came from an HTTP request, a scheduler tick, or a
// BullMQ job. The infrastructure does not depend on the prefix — it's
// purely a debugging affordance.

const SHORT_UUID_LEN = 8;

function shortId(): string {
  return randomUUID().slice(0, SHORT_UUID_LEN);
}

export function newHttpTraceId(): string {
  return `req-${randomUUID()}`;
}

export function newSchedulerTraceId(name: string): string {
  return `sched-${name}-${shortId()}`;
}

export function newWorkerTraceId(queueName: string, jobId: string | number): string {
  return `job-${queueName}-${jobId}`;
}

export function newWebhookTraceId(source: string): string {
  return `wh-${source}-${shortId()}`;
}

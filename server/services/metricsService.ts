/**
 * metricsService — Phase 10 observability queries.
 *
 * All queries run against the `orders` table (+ `integrations` for labels).
 * All functions accept a `userId` filter so non-admin views can be scoped
 * per-tenant; pass `null` for a global admin view.
 *
 * Performance notes:
 *   • Summary stats use (userId, status) index → O(index range scan)
 *   • Time-series uses (createdAt) index + GROUP BY DATE  *   • Adapter/errorType breakdown requires a full-table-range scan when
 *     the new columns are NULL (legacy rows). Gets faster as new rows fill in.
 */

import { and, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { DbClient } from "../db";
import { orders, integrations } from "../../drizzle/schema";
import { ORDER_MAX_DELIVERY_ATTEMPTS } from "../lib/orderRetryPolicy";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PeriodStats {
  total:       number;
  sent:        number;
  failed:      number;
  pending:     number;
  successRate: number;   // 0–100
  avgDurationMs: number | null;
  p95DurationMs: number | null;
}

export interface DailyPoint {
  date:    string;  // "YYYY-MM-DD"
  total:   number;
  sent:    number;
  failed:  number;
}

export interface AdapterStat {
  adapterKey:   string;
  total:        number;
  sent:         number;
  failed:       number;
  successRate:  number;
  avgDurationMs: number | null;
  /** Sprint 5 / Item 5.4 — latency percentiles for capacity planning. */
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
}

export interface ErrorTypeStat {
  errorType: string;
  count:     number;
}

export interface QueueStats {
  pending:     number;
  retryable:   number;  // FAILED, attempts < max, nextRetryAt due
  dlq:         number;  // FAILED, attempts >= max
  overdue:     number;  // FAILED, due for retry but not picked up yet
}

export interface IntegrationStat {
  integrationId:   number;
  integrationName: string;
  total:           number;
  sent:            number;
  failed:          number;
  successRate:     number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sinceDate(periodHours: number): Date {
  return new Date(Date.now() - periodHours * 60 * 60 * 1000);
}

function safePct(num: number, den: number): number {
  if (den === 0) return 0;
  return Math.round((num / den) * 100);
}

// ─── Period summary stats ─────────────────────────────────────────────────────

export async function getPeriodStats(
  db: DbClient,
  periodHours: number,
  userId: number | null,
): Promise<PeriodStats> {
  const since = sinceDate(periodHours);
  const conds = [gte(orders.createdAt, since)];
  if (userId !== null) conds.push(eq(orders.userId, userId));

  const rows = await db
    .select({
      status:    orders.status,
      duration:  orders.durationMs,
    })
    .from(orders)
    .where(and(...conds));

  let sent = 0, failed = 0, pending = 0;
  const durations: number[] = [];

  for (const r of rows) {
    if (r.status === "SENT")    sent++;
    else if (r.status === "FAILED")  failed++;
    else                        pending++;
    if (r.duration != null) durations.push(r.duration);
  }

  const total = sent + failed + pending;
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  let p95DurationMs: number | null = null;
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    const idx = Math.ceil(durations.length * 0.95) - 1;
    p95DurationMs = durations[Math.max(0, idx)];
  }

  return {
    total,
    sent,
    failed,
    pending,
    successRate: safePct(sent, sent + failed),
    avgDurationMs,
    p95DurationMs,
  };
}

// ─── Daily time series ────────────────────────────────────────────────────────

export async function getDailyTimeSeries(
  db: DbClient,
  days: number,
  userId: number | null,
): Promise<DailyPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const conds = [gte(orders.createdAt, since)];
  if (userId !== null) conds.push(eq(orders.userId, userId));

  const rows = await db
    .select({
      date:   sql<string>`DATE(${orders.createdAt})`.as("date"),
      status: orders.status,
      cnt:    sql<number>`COUNT(*)`.as("cnt"),
    })
    .from(orders)
    .where(and(...conds))
    .groupBy(sql`DATE(${orders.createdAt})`, orders.status)
    .orderBy(sql`DATE(${orders.createdAt})`);

  // Merge by date
  const byDate = new Map<string, DailyPoint>();
  for (const r of rows) {
    const d = r.date;
    if (!byDate.has(d)) byDate.set(d, { date: d, total: 0, sent: 0, failed: 0 });
    const pt = byDate.get(d)!;
    const n = Number(r.cnt);
    pt.total += n;
    if (r.status === "SENT")   pt.sent   += n;
    if (r.status === "FAILED") pt.failed += n;
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Adapter breakdown ────────────────────────────────────────────────────────

export async function getAdapterBreakdown(
  db: DbClient,
  periodHours: number,
  userId: number | null,
): Promise<AdapterStat[]> {
  const since = sinceDate(periodHours);
  const conds = [gte(orders.createdAt, since), isNotNull(orders.adapterKey)];
  if (userId !== null) conds.push(eq(orders.userId, userId));

  const rows = await db
    .select({
      adapterKey: orders.adapterKey,
      status:     orders.status,
      duration:   orders.durationMs,
    })
    .from(orders)
    .where(and(...conds));

  const map = new Map<string, { sent: number; failed: number; durations: number[] }>();
  for (const r of rows) {
    const key = r.adapterKey ?? "unknown";
    if (!map.has(key)) map.set(key, { sent: 0, failed: 0, durations: [] });
    const s = map.get(key)!;
    if (r.status === "SENT")   s.sent++;
    if (r.status === "FAILED") s.failed++;
    if (r.duration != null)    s.durations.push(r.duration);
  }

  return Array.from(map.entries()).map(([key, s]) => {
    const ds = s.durations.length > 0 ? [...s.durations].sort((a, b) => a - b) : [];
    const pct = (p: number): number | null => {
      if (ds.length === 0) return null;
      const idx = Math.max(0, Math.ceil(ds.length * p) - 1);
      return ds[idx] ?? null;
    };
    return {
      adapterKey: key,
      total: s.sent + s.failed,
      sent: s.sent,
      failed: s.failed,
      successRate: safePct(s.sent, s.sent + s.failed),
      avgDurationMs: ds.length > 0
        ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length)
        : null,
      p50DurationMs: pct(0.5),
      p95DurationMs: pct(0.95),
      p99DurationMs: pct(0.99),
    };
  }).sort((a, b) => b.total - a.total);
}

// ─── Error type distribution ──────────────────────────────────────────────────

export async function getErrorDistribution(
  db: DbClient,
  periodHours: number,
  userId: number | null,
): Promise<ErrorTypeStat[]> {
  const since = sinceDate(periodHours);
  const conds = [
    gte(orders.createdAt, since),
    eq(orders.status, "FAILED"),
    isNotNull(orders.errorType),
  ];
  if (userId !== null) conds.push(eq(orders.userId, userId));

  const rows = await db
    .select({
      errorType: orders.errorType,
      cnt:       sql<number>`COUNT(*)`.as("cnt"),
    })
    .from(orders)
    .where(and(...conds))
    .groupBy(orders.errorType)
    .orderBy(sql`COUNT(*) DESC`);

  return rows.map((r) => ({
    errorType: r.errorType ?? "unknown",
    count:     Number(r.cnt),
  }));
}

// ─── Queue stats ──────────────────────────────────────────────────────────────

export async function getQueueStats(
  db: DbClient,
  userId: number | null,
): Promise<QueueStats> {
  const now = new Date();
  const conds = userId !== null ? [eq(orders.userId, userId)] : [];

  const rows = await db
    .select({ status: orders.status, attempts: orders.attempts, nextRetryAt: orders.nextRetryAt })
    .from(orders)
    .where(conds.length > 0 ? and(...conds) : undefined);

  let pending = 0, retryable = 0, dlq = 0, overdue = 0;
  for (const r of rows) {
    if (r.status === "PENDING") { pending++; continue; }
    if (r.status !== "FAILED")  continue;
    if (r.attempts >= ORDER_MAX_DELIVERY_ATTEMPTS) { dlq++; continue; }
    retryable++;
    if (r.nextRetryAt && r.nextRetryAt <= now) overdue++;
  }

  return { pending, retryable, dlq, overdue };
}

// ─── Per-integration breakdown ────────────────────────────────────────────────

export async function getIntegrationBreakdown(
  db: DbClient,
  periodHours: number,
  userId: number | null,
  limit = 20,
): Promise<IntegrationStat[]> {
  const since = sinceDate(periodHours);
  const conds = [gte(orders.createdAt, since)];
  if (userId !== null) conds.push(eq(orders.userId, userId));

  const rows = await db
    .select({
      integrationId:   orders.integrationId,
      integrationName: integrations.name,
      status:          orders.status,
      cnt:             sql<number>`COUNT(*)`.as("cnt"),
    })
    .from(orders)
    .leftJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(and(...conds))
    .groupBy(orders.integrationId, integrations.name, orders.status)
    .orderBy(sql`COUNT(*) DESC`);

  const map = new Map<number, IntegrationStat>();
  for (const r of rows) {
    const id = r.integrationId;
    if (!map.has(id)) {
      map.set(id, {
        integrationId:   id,
        integrationName: r.integrationName ?? `Integration #${id}`,
        total:  0, sent: 0, failed: 0, successRate: 0,
      });
    }
    const s = map.get(id)!;
    const n = Number(r.cnt);
    s.total += n;
    if (r.status === "SENT")   s.sent   += n;
    if (r.status === "FAILED") s.failed += n;
  }

  return Array.from(map.values())
    .map((s) => ({ ...s, successRate: safePct(s.sent, s.sent + s.failed) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

import { eq, desc, count, and, sql, inArray, gte, lt, or, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import {
  InsertUser,
  users,
  leads,
  orders,
  integrations,
  webhookEvents,
  type Lead,
  type Order,
  type Integration,
  type WebhookEvent,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getDashboardDayUtcBounds } from "./lib/dashboardTimezone";

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: mysql.Pool | null = null;

/**
 * Resolves the MySQL connection URL from environment variables.
 * Railway auto-sets DATABASE_URL to a socket path (/var/lib/mysql) when MySQL
 * is linked as a plugin. We prefer TCP URLs (MYSQL_PUBLIC_URL, MYSQL_URL) over
 * socket paths so mysql2 can connect properly.
 */
function resolveDatabaseUrl(): string | undefined {
  const candidates = [
    process.env.MYSQL_PUBLIC_URL,  // Railway public TCP URL (preferred: works from both web + worker)
    process.env.MYSQL_URL,          // Railway internal TCP URL (fallback)
    process.env.DATABASE_URL,       // Generic fallback
  ];

  for (const raw of candidates) {
    // Strip leading '=' that Railway sometimes prepends to variable values
    const url = raw?.trim().replace(/^=+/, "");
    if (url && url.startsWith("mysql://")) {
      return url;
    }
  }

  // Last resort: return DATABASE_URL even if it's a socket (will fail gracefully)
  return process.env.DATABASE_URL?.trim().replace(/^=+/, "");
}

export async function getDb() {
  if (!_db) {
    const url = resolveDatabaseUrl();
    if (url) {
      try {
        // Force UTF-8 end-to-end to avoid mojibake when storing non-Latin lead fields.
        // MySQL server defaults (and some dumps) can fall back to latin1 unless explicitly set.
        //
        // `timezone: 'Z'` pins the client to UTC: JS Dates are serialized as
        // UTC wall-clock strings, and TIMESTAMP columns are parsed back as
        // UTC. Without this, mysql2's default 'local' setting combined with a
        // server session TZ of UTC (Railway's MySQL default + most local
        // installs) produces a shift equal to the host's UTC offset on every
        // write — silently corrupting any code that does `cooldownUntil <=
        // NOW()`-style server-side comparisons (see circuitBreaker.ts).
        // Internally MySQL stores TIMESTAMPs as UTC ms regardless of session
        // TZ, so this change preserves the absolute moment of existing data.
        _pool = mysql.createPool({
          uri: url,
          charset: "utf8mb4",
          timezone: "Z",
          // Keep behavior predictable across environments.
          decimalNumbers: true,
        });
        // Pin every pooled connection's MySQL SESSION timezone to UTC. Without
        // this, `SET time_zone='SYSTEM'` lets the server interpret the UTC
        // wall-clock strings we send (because of `timezone: 'Z'` above) as
        // local-system-TZ — silently shifting stored TIMESTAMPs by the host's
        // offset. Setting it once per connection keeps client + server
        // aligned, which is the only configuration where server-side
        // expressions like `cooldownUntil <= NOW()` are reliable.
        _pool.on("connection", (connection: { query: (sql: string) => void }) => {
          connection.query("SET time_zone='+00:00'");
        });
        _db = drizzle(_pool);
        // Verify the pool actually reaches the server — createPool/drizzle are lazy.
        await _db.execute(sql`SELECT 1`);
        console.log("[Database] Connected via", url.startsWith("mysql://")
          ? url.replace(/:\/\/[^@]+@/, "://<credentials>@")
          : "(socket)");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Database] Connection failed:", msg, "| URL:", url.startsWith("mysql://") ? url.replace(/:\/\/[^@]+@/, "://<hidden>@") : "(non-tcp)");
        _db = null;
        _pool = null;
      }
    }
  }
  return _db;
}

/** Close MySQL pool so CLI scripts exit immediately (pool keeps Node alive otherwise). */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export type DbClient = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ─── Users ────────────────────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Leads ────────────────────────────────────────────────────────────────────
export async function getLeads(
  userId: number,
  limit = 50,
  offset = 0,
  search?: string,
  status?: "PENDING" | "RECEIVED" | "FAILED",
  pageId?: string,
  formId?: string,
  pageIds?: string[],
  platform?: "fb" | "ig"
): Promise<Lead[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(leads.userId, userId)];

  // Visibility rule: only show leads that have been routed at least once
  // (i.e., at least one integration delivery attempt exists).
  conditions.push(
    sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
  );

  if (status === "PENDING") {
    const enrichedPending = and(
      eq(leads.dataStatus, "ENRICHED"),
      inArray(leads.deliveryStatus, ["PENDING", "PROCESSING"])
    );
    const pendingPred: SQL = and(
      ne(leads.dataStatus, "ERROR"),
      or(eq(leads.dataStatus, "PENDING"), enrichedPending as SQL)
    ) as SQL;
    conditions.push(pendingPred);
  } else if (status === "RECEIVED") {
    conditions.push(and(eq(leads.dataStatus, "ENRICHED"), eq(leads.deliveryStatus, "SUCCESS")) as SQL);
  } else if (status === "FAILED") {
    conditions.push(
      or(eq(leads.dataStatus, "ERROR"), inArray(leads.deliveryStatus, ["FAILED", "PARTIAL"])) as SQL
    );
  }
  if (pageId)   conditions.push(eq(leads.pageId,   pageId));
  if (formId)   conditions.push(eq(leads.formId,   formId));
  if (platform) conditions.push(eq(leads.platform, platform));
  if (pageIds && pageIds.length > 0) conditions.push(inArray(leads.pageId, pageIds));
  if (search) {
    const like = `%${search}%`;
    conditions.push(
      sql`(${leads.fullName} LIKE ${like} OR ${leads.phone} LIKE ${like} OR ${leads.email} LIKE ${like} OR ${leads.leadgenId} LIKE ${like})`
    );
  }
  return db
    .select()
    .from(leads)
    .where(and(...(conditions as [SQL, ...SQL[]])))
    .orderBy(desc(leads.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getLeadById(id: number, userId?: number): Promise<Lead | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const condition = userId !== undefined
    ? and(eq(leads.id, id), eq(leads.userId, userId))
    : eq(leads.id, id);
  const [lead] = await db.select().from(leads).where(condition).limit(1);
  return lead;
}

export async function getLeadStats(userId: number) {
  const db = await getDb();
  if (!db) return { total: 0, pending: 0, received: 0, failed: 0, todayReceived: 0, yesterdayReceived: 0 };

  const { start: todayStart, end: todayEnd } = getDashboardDayUtcBounds();
  // Yesterday bounds: shift both bounds back by exactly 24 h
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayEnd   = todayStart; // yesterday's end = today's start

  const [[row], [todayRow], [yesterdayRow]] = await Promise.all([
    // All-time pipeline stats (only leads that have been routed at least once)
    db
      .select({
        total: count(),
        pending:  sql<number>`SUM(CASE WHEN (${leads.dataStatus} != 'ERROR' AND (${leads.dataStatus} = 'PENDING' OR (${leads.dataStatus} = 'ENRICHED' AND ${leads.deliveryStatus} IN ('PENDING','PROCESSING')))) THEN 1 ELSE 0 END)`,
        received: sql<number>`SUM(CASE WHEN ${leads.dataStatus} = 'ENRICHED' AND ${leads.deliveryStatus} = 'SUCCESS' THEN 1 ELSE 0 END)`,
        failed:   sql<number>`SUM(CASE WHEN ${leads.dataStatus} = 'ERROR' OR ${leads.deliveryStatus} IN ('FAILED','PARTIAL') THEN 1 ELSE 0 END)`,
      })
      .from(leads)
      .where(
        and(
          eq(leads.userId, userId),
          sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
        )
      ),
    // Leads received TODAY (integration-filtered — consistent with Leads page)
    db
      .select({ n: count() })
      .from(leads)
      .where(and(
        eq(leads.userId, userId),
        gte(leads.createdAt, todayStart),
        lt(leads.createdAt, todayEnd),
        sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
      )),
    // Leads received YESTERDAY (integration-filtered — used for trend comparison)
    db
      .select({ n: count() })
      .from(leads)
      .where(and(
        eq(leads.userId, userId),
        gte(leads.createdAt, yesterdayStart),
        lt(leads.createdAt, yesterdayEnd),
        sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
      )),
  ]);

  return {
    ...(row ?? { total: 0, pending: 0, received: 0, failed: 0 }),
    todayReceived:     Number(todayRow?.n     ?? 0),
    yesterdayReceived: Number(yesterdayRow?.n ?? 0),
  };
}

export async function getLeadsCount(
  userId: number,
  search?: string,
  status?: "PENDING" | "RECEIVED" | "FAILED",
  pageId?: string,
  formId?: string,
  pageIds?: string[],
  platform?: "fb" | "ig"
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [eq(leads.userId, userId)];

  // Same visibility rule as getLeads(): only count leads that have been routed at least once.
  conditions.push(
    sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
  );

  if (status === "PENDING") {
    const enrichedPending = and(
      eq(leads.dataStatus, "ENRICHED"),
      inArray(leads.deliveryStatus, ["PENDING", "PROCESSING"])
    );
    const pendingPred: SQL = and(
      ne(leads.dataStatus, "ERROR"),
      or(eq(leads.dataStatus, "PENDING"), enrichedPending as SQL)
    ) as SQL;
    conditions.push(pendingPred);
  } else if (status === "RECEIVED") {
    conditions.push(and(eq(leads.dataStatus, "ENRICHED"), eq(leads.deliveryStatus, "SUCCESS")) as SQL);
  } else if (status === "FAILED") {
    conditions.push(
      or(eq(leads.dataStatus, "ERROR"), inArray(leads.deliveryStatus, ["FAILED", "PARTIAL"])) as SQL
    );
  }
  if (pageId)   conditions.push(eq(leads.pageId,   pageId));
  if (formId)   conditions.push(eq(leads.formId,   formId));
  if (platform) conditions.push(eq(leads.platform, platform));
  if (pageIds && pageIds.length > 0) conditions.push(inArray(leads.pageId, pageIds));
  if (search) {
    const like = `%${search}%`;
    conditions.push(
      sql`(${leads.fullName} LIKE ${like} OR ${leads.phone} LIKE ${like} OR ${leads.email} LIKE ${like} OR ${leads.leadgenId} LIKE ${like})`
    );
  }
  const [row] = await db.select({ count: count() }).from(leads).where(and(...(conditions as [SQL, ...SQL[]])));
  return row?.count ?? 0;
}

// ─── Orders ───────────────────────────────────────────────────────────────────
export async function getOrdersByLeadId(leadId: number): Promise<Order[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(orders).where(eq(orders.leadId, leadId)).orderBy(desc(orders.createdAt));
}

export async function getOrderStats(userId: number) {
  const db = await getDb();
  if (!db) return { total: 0, sent: 0, sentToday: 0, failed: 0, pending: 0 };
  const { start, end } = getDashboardDayUtcBounds();

  const [[row], [sentTodayRow]] = await Promise.all([
    db
      .select({
        total: count(),
        sent: sql<number>`SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)`,
      })
      .from(orders)
      .where(eq(orders.userId, userId)),
    db
      .select({ n: count() })
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          eq(orders.status, "SENT"),
          gte(orders.createdAt, start),
          lt(orders.createdAt, end)
        )
      ),
  ]);

  const base = row ?? { total: 0, sent: 0, failed: 0, pending: 0 };
  return {
    ...base,
    sentToday: Number(sentTodayRow?.n ?? 0),
  };
}

/** Distinct leads (per user) with integration activity for the dashboard calendar day (Asia/Tashkent). */
export async function getTodayIntegrationLeadStats(userId: number) {
  const db = await getDb();
  if (!db) {
    return { leadsWithDeliveryToday: 0, leadsWithFailedDeliveryToday: 0 };
  }
  const { start, end } = getDashboardDayUtcBounds();

  const [sentRow] = await db
    .select({
      n: sql<number>`COUNT(DISTINCT ${orders.leadId})`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.status, "SENT"),
        gte(orders.createdAt, start),
        lt(orders.createdAt, end)
      )
    );
  const [failRow] = await db
    .select({
      n: sql<number>`COUNT(DISTINCT ${orders.leadId})`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.status, "FAILED"),
        gte(orders.createdAt, start),
        lt(orders.createdAt, end)
      )
    );
  return {
    leadsWithDeliveryToday: Number(sentRow?.n ?? 0),
    leadsWithFailedDeliveryToday: Number(failRow?.n ?? 0),
  };
}

// ─── Integrations ─────────────────────────────────────────────────────────────
export async function getIntegrations(userId: number): Promise<Integration[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(integrations).where(eq(integrations.userId, userId)).orderBy(desc(integrations.createdAt));
}

/**
 * Extract a numeric destinationId from an integration config JSON.
 * Accepts both number and numeric-string forms (historical inconsistency).
 */
function extractDestinationIdFromConfig(cfg: Record<string, unknown> | null | undefined): number | null {
  const raw = cfg?.destinationId;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
}

/**
 * Strict dual-write into integration_routes.
 *
 * Mirrors the single-destination integration shape into the N:1 join table
 * — the ONLY path the delivery resolver reads from since the legacy
 * fallback was retired on 2026-05-12. A failure here means the integration
 * has no destinations at all and would silently drop every lead, so we
 * throw a structured error and let the caller (createIntegration /
 * updateIntegration) decide how to undo the parent insert.
 *
 * Idempotency: `syncLegacyDestination` is itself idempotent (delete-then-
 * insert in a transaction), so caller retries are safe.
 */
async function strictSyncLegacyDestination(
  db: DbClient,
  integrationId: number,
  destinationId: number | null,
): Promise<void> {
  const { syncLegacyDestination } = await import("./services/integrationRoutes");
  try {
    await syncLegacyDestination(db, integrationId, destinationId);
  } catch (err) {
    // Log loudly first so the failure is captured even if the caller's
    // rollback path itself trips. Then rethrow so the caller can clean
    // up the parent integration row.
    console.error(
      `[dual-write] integration_routes sync FAILED for integrationId=${integrationId} — ` +
        `the parent integration row will be removed to keep state consistent.`,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

/**
 * Observability for Sprint A Step 5b — detect callers that omit the top-level
 * dedicated fields and only embed them inside `config`. Such callers are
 * stale browser tabs running the pre-c4c7302 wizard build. When telemetry
 * shows zero hits for an extended window, the JSON fallbacks in
 * `createIntegration` / `updateIntegration` can be dropped.
 */
const LEGACY_WIZARD_FIELDS = ["pageId", "formId", "pageName", "formName", "facebookAccountId", "destinationId"] as const;
function warnIfLegacyWizardShape(
  caller: "createIntegration" | "updateIntegration",
  topLevel: Partial<Record<(typeof LEGACY_WIZARD_FIELDS)[number], unknown>>,
  cfg: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): void {
  const fallbackFields: string[] = [];
  for (const k of LEGACY_WIZARD_FIELDS) {
    if (topLevel[k] === undefined && cfg?.[k] !== undefined) fallbackFields.push(k);
  }
  if (topLevel.facebookAccountId === undefined && cfg?.accountId !== undefined && !fallbackFields.includes("facebookAccountId")) {
    fallbackFields.push("facebookAccountId(via accountId alias)");
  }
  if (fallbackFields.length > 0) {
    console.warn(`[${caller}] legacy wizard shape — top-level missing, fell back to config:`, {
      fields: fallbackFields,
      ...extra,
    });
  }
}

export async function createIntegration(data: {
  userId: number;
  type: "LEAD_ROUTING";
  name: string;
  config: unknown;
  telegramChatId?: string | null;
  /**
   * Ordered destination IDs for multi-destination fan-out.
   * When provided, `integration_routes` is populated with the full
   * list (preserving array order as `position`). Otherwise the single id
   * from `config.destinationId` is used (single-destination path).
   */
  destinationIds?: number[];
  /**
   * Top-level dedicated fields (preferred). When provided, these win over
   * the matching keys in `config`. The config fallback remains for older
   * callers that still embed these values inside the JSON.
   */
  pageId?: string;
  formId?: string;
  pageName?: string;
  formName?: string;
  facebookAccountId?: number;
  destinationId?: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Populate dedicated columns: prefer top-level fields, fall back to config
  // keys for older callers that still embed them in the JSON.
  const cfg = data.config as Record<string, unknown> | null;
  const isLR = data.type === "LEAD_ROUTING";
  if (isLR) warnIfLegacyWizardShape("createIntegration", data, cfg);
  const pageId = isLR ? (data.pageId ?? (String(cfg?.pageId ?? "") || null)) : null;
  const formId = isLR ? (data.formId ?? (String(cfg?.formId ?? "") || null)) : null;
  const pageName = isLR ? (data.pageName ?? (String(cfg?.pageName ?? "") || null)) : null;
  const formName = isLR ? (data.formName ?? (String(cfg?.formName ?? "") || null)) : null;
  const rawFbId = isLR ? (data.facebookAccountId ?? cfg?.facebookAccountId ?? cfg?.accountId) : undefined;
  const facebookAccountId = typeof rawFbId === "number" && rawFbId > 0 ? rawFbId : null;
  // Extract the primary destination id: prefer top-level, fall back to JSON.
  const destinationId = isLR
    ? (data.destinationId ?? extractDestinationIdFromConfig(cfg))
    : null;

  const [result] = await db.insert(integrations).values({
    userId: data.userId,
    type: data.type,
    name: data.name,
    config: data.config,
    telegramChatId: data.telegramChatId ?? null,
    isActive: true,
    pageId,
    formId,
    pageName,
    formName,
    facebookAccountId,
    destinationId,
  });

  // Strict dual-write into the new join table. Since the legacy fallback
  // was retired (see services/integrationRoutes.ts:resolve…), the
  // delivery resolver ONLY reads from integration_routes — an
  // integration without rows here silently drops every lead. We treat a
  // failure as fatal and roll back the parent row so the user can retry
  // instead of being left with a broken integration they cannot diagnose.
  const insertedId = (result as { insertId?: number })?.insertId;
  if (isLR && typeof insertedId === "number" && insertedId > 0) {
    const destIds = data.destinationIds;
    try {
      if (destIds && destIds.length > 0) {
        // Multi-destination path: write all ids in order.
        // `setIntegrationRoutes` runs inside its own transaction so
        // the mapping is consistent even if the process crashes mid-way.
        const { setIntegrationRoutes } = await import("./services/integrationRoutes");
        await setIntegrationRoutes(db, insertedId, destIds);
      } else {
        // Single-destination path: mirror the column id.
        await strictSyncLegacyDestination(db, insertedId, destinationId);
      }
    } catch (err) {
      // Roll back the parent row so the caller doesn't accumulate orphan
      // integrations on every transient failure. The delete is itself
      // best-effort — if it fails too, log loudly so admins can spot the
      // drift and reconcile via tooling/mysql/backfill-integration-destinations.mjs.
      try {
        await db.delete(integrations).where(eq(integrations.id, insertedId));
      } catch (rollbackErr) {
        console.error(
          `[createIntegration] CRITICAL: rollback of orphan integration #${insertedId} failed — ` +
            `manual cleanup required. Run tooling/mysql/backfill-integration-destinations.mjs ` +
            `to reconcile.`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        );
      }
      throw err instanceof Error
        ? err
        : new Error(`integration_routes write failed for new integration: ${String(err)}`);
    }
  }
}

export async function updateIntegration(
  id: number,
  data: Partial<{
    name: string;
    config: unknown;
    isActive: boolean;
    telegramChatId: string | null;
    /**
     * Optional ordered list of destination ids (Stage B opt-in write).
     *
     * When provided, `integration_routes` is authoritatively rewritten
     * to this exact list AND the legacy `integrations.destinationId`
     * column is set to the first entry (or null for an empty list).
     * Callers must have already verified ownership of each id — this helper
     * does not re-check (same contract as `createIntegration`).
     *
     * When omitted, the legacy single-id mirror (`safeSyncLegacyDestination`)
     * runs with the ID extracted from `config.destinationId` — EXCEPT
     * when the integration already has multiple destinations wired up; see
     * the guard below.
     */
    destinationIds: number[];
    /**
     * Top-level dedicated fields — preferred over the matching keys in
     * `config` when present. See `createIntegration` doc above.
     */
    pageId: string;
    formId: string;
    pageName: string;
    formName: string;
    facebookAccountId: number;
    destinationId: number;
  }>,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Keep dedicated columns in sync when config is updated.
  // `destinationIds` is handled separately below — strip it before the
  // plain SQL UPDATE so it doesn't land as a bogus column value.
  // Top-level dedicated fields also bypass the UPDATE statement directly —
  // they're applied to `updateData` further down.
  const {
    destinationIds,
    pageId: topPageId,
    formId: topFormId,
    pageName: topPageName,
    formName: topFormName,
    facebookAccountId: topFbAccountId,
    destinationId: topTwId,
    ...dbFields
  } = data;
  const updateData: Record<string, unknown> = { ...dbFields };
  let twIdForSync: number | null | undefined;
  if (
    dbFields.config !== undefined ||
    topPageId !== undefined ||
    topFormId !== undefined ||
    topPageName !== undefined ||
    topFormName !== undefined ||
    topFbAccountId !== undefined ||
    topTwId !== undefined
  ) {
    const cfg = (dbFields.config ?? null) as Record<string, unknown> | null;
    warnIfLegacyWizardShape("updateIntegration", {
      pageId: topPageId,
      formId: topFormId,
      pageName: topPageName,
      formName: topFormName,
      facebookAccountId: topFbAccountId,
      destinationId: topTwId,
    }, cfg, { id });
    updateData.pageId = topPageId ?? (String(cfg?.pageId ?? "") || null);
    updateData.formId = topFormId ?? (String(cfg?.formId ?? "") || null);
    updateData.pageName = topPageName ?? (String(cfg?.pageName ?? "") || null);
    updateData.formName = topFormName ?? (String(cfg?.formName ?? "") || null);
    const rawFbId = topFbAccountId ?? cfg?.facebookAccountId ?? cfg?.accountId;
    updateData.facebookAccountId = typeof rawFbId === "number" && rawFbId > 0 ? rawFbId : null;
    // Keep the dedicated column and the destination table in sync together.
    twIdForSync = topTwId ?? extractDestinationIdFromConfig(cfg);
    updateData.destinationId = twIdForSync;
  }

  // When an explicit destinationIds list is provided, let it override the
  // legacy column write so both surfaces agree with the caller's intent.
  if (destinationIds !== undefined) {
    const firstId =
      destinationIds.length > 0 ? destinationIds[0] : null;
    updateData.destinationId = firstId;
  }

  await db.update(integrations).set(updateData).where(eq(integrations.id, id));

  // ── Destination-mapping sync ──────────────────────────────────────────────
  //
  // Three branches, in strictest-safest order:
  //
  //   1. EXPLICIT LIST — the caller passed `destinationIds`. Rewrite the
  //      join table to match exactly. This is the V2 wizard path.
  //
  //   2. LEGACY MIRROR with GUARD — no explicit list, but `config` was part
  //      of the update (so `twIdForSync` was computed from it). Only mirror
  //      the single id if the integration currently has ≤1 row in the join
  //      table. When it already has MULTIPLE destinations we leave the
  //      join alone to avoid silently collapsing a 3-dest integration into
  //      1 every time the user renames it. This is the Stage B data-loss
  //      guard — the bug the classic edit wizard could trigger.
  //
  //   3. NO CHANGE — `config` wasn't touched and no explicit list was
  //      passed. Leave the mapping as-is (matches old behaviour).
  //
  // Notes:
  //   - The guard uses `countIntegrationRoutes` (single small SELECT)
  //     so overhead on every update is negligible.
  //   - Sync errors now PROPAGATE: the legacy fallback is gone, so an
  //     unsynced join row means future leads silently drop. Letting the
  //     mutation fail forces the caller to retry until consistent.
  if (destinationIds !== undefined) {
    const { setIntegrationRoutes } = await import(
      "./services/integrationRoutes"
    );
    await setIntegrationRoutes(db, id, destinationIds);
  } else if (twIdForSync !== undefined) {
    const { countIntegrationRoutes } = await import(
      "./services/integrationRoutes"
    );
    const existingCount = await countIntegrationRoutes(db, id);

    if (existingCount > 1) {
      // Multi-destination integration — DO NOT mirror the single id.
      // Silently skipping keeps the existing mapping rows intact; the
      // caller can opt into overwrite by passing `destinationIds`.
      console.warn(
        `[updateIntegration] integrationId=${id} has ${existingCount} destinations; ` +
          `skipping legacy single-id mirror to prevent data loss. ` +
          `Pass destinationIds to the update to rewrite the list explicitly.`,
      );
    } else {
      await strictSyncLegacyDestination(db, id, twIdForSync);
    }
  }
}

export async function deleteIntegration(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // The FK on integration_routes.integrationId CASCADEs, so the
  // delete below implicitly wipes the mapping rows. Explicit safeSync with
  // an empty list would only duplicate that work — we let the DB handle it.
  await db.delete(integrations).where(eq(integrations.id, id));
}

// ─── Webhook Events ───────────────────────────────────────────────────────────
export async function getRecentWebhookEvents(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  // Exclude the large `payload` json column to avoid superjson Max Depth issues
  return db
    .select({
      id: webhookEvents.id,
      eventType: webhookEvents.eventType,
      signature: webhookEvents.signature,
      verified: webhookEvents.verified,
      processed: webhookEvents.processed,
      error: webhookEvents.error,
      createdAt: webhookEvents.createdAt,
    })
    .from(webhookEvents)
    .orderBy(desc(webhookEvents.createdAt))
    .limit(limit);
}

export async function getWebhookStats() {
  const db = await getDb();
  if (!db) return { total: 0, verified: 0, processed: 0, failed: 0 };
  const [row] = await db
    .select({
      total: count(),
      verified: sql<number>`SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END)`,
      processed: sql<number>`SUM(CASE WHEN processed = 1 THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(webhookEvents);
  return row ?? { total: 0, verified: 0, processed: 0, failed: 0 };
}

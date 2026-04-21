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
        _pool = mysql.createPool({
          uri: url,
          charset: "utf8mb4",
          // Keep behavior predictable across environments.
          decimalNumbers: true,
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
 * Extract a numeric targetWebsiteId from an integration config JSON.
 * Accepts both number and numeric-string forms (historical inconsistency).
 */
function extractTargetWebsiteId(cfg: Record<string, unknown> | null | undefined): number | null {
  const raw = cfg?.targetWebsiteId;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
}

/**
 * Best-effort dual-write into integration_destinations. Part of Commit 4 of
 * Phase 4. Failures are swallowed with a warn-log so a transient glitch on
 * the new table cannot break integration CRUD — dispatch still consumes
 * the legacy `integrations.targetWebsiteId` column until Commit 5 flips the
 * feature flag. Drift (if any) is repaired by the idempotent backfill
 * script at tooling/mysql/backfill-integration-destinations.mjs.
 */
async function safeSyncLegacyDestination(
  db: DbClient,
  integrationId: number,
  targetWebsiteId: number | null,
): Promise<void> {
  try {
    const { syncLegacyDestination } = await import("./services/integrationDestinations");
    await syncLegacyDestination(db, integrationId, targetWebsiteId);
  } catch (err) {
    console.warn(
      `[dual-write] integration_destinations sync failed for integrationId=${integrationId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function createIntegration(data: {
  userId: number;
  type: "AFFILIATE" | "LEAD_ROUTING";
  name: string;
  config: unknown;
  telegramChatId?: string | null;
  /**
   * Ordered destination IDs for fan-out (Commit 6c).
   * When provided, `integration_destinations` is populated with the full
   * list (preserving order as `position`). Otherwise the single id from
   * `config.targetWebsiteId` is used (legacy / single-destination path).
   */
  destinationIds?: number[];
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Populate dedicated columns from config (source of truth during creation)
  const cfg = data.config as Record<string, unknown> | null;
  const isLR = data.type === "LEAD_ROUTING";
  const pageId = isLR ? (String(cfg?.pageId ?? "") || null) : null;
  const formId = isLR ? (String(cfg?.formId ?? "") || null) : null;
  const pageName = isLR ? (String(cfg?.pageName ?? "") || null) : null;
  const formName = isLR ? (String(cfg?.formName ?? "") || null) : null;
  const rawFbId = isLR ? (cfg?.facebookAccountId ?? cfg?.accountId) : undefined;
  const facebookAccountId = typeof rawFbId === "number" && rawFbId > 0 ? rawFbId : null;
  // Commit 4: previously this column was populated only by a later backfill.
  // We now set it at creation time so the legacy dispatch path sees the id
  // immediately and the dual-write mirror below has a canonical source.
  const targetWebsiteId = isLR ? extractTargetWebsiteId(cfg) : null;

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
    targetWebsiteId,
  });

  // Dual-write into the new join table.
  const insertedId = (result as { insertId?: number })?.insertId;
  if (isLR && typeof insertedId === "number" && insertedId > 0) {
    const destIds = data.destinationIds;
    if (destIds && destIds.length > 0) {
      // Multi-destination path (Commit 6c): write all ids in order.
      // `setIntegrationDestinations` runs inside a transaction, so the
      // mapping is always consistent even if the process crashes mid-way.
      try {
        const { setIntegrationDestinations } = await import("./services/integrationDestinations");
        await setIntegrationDestinations(db, insertedId, destIds);
      } catch (err) {
        console.warn(
          `[dual-write] setIntegrationDestinations failed for integrationId=${insertedId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      // Single-destination / legacy path: mirror the config column only.
      await safeSyncLegacyDestination(db, insertedId, targetWebsiteId);
    }
  }
}

export async function updateIntegration(id: number, data: Partial<{ name: string; config: unknown; isActive: boolean; telegramChatId: string | null }>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Keep dedicated columns in sync when config is updated
  const updateData: Record<string, unknown> = { ...data };
  let twIdForSync: number | null | undefined;
  if (data.config !== undefined) {
    const cfg = data.config as Record<string, unknown> | null;
    updateData.pageId = String(cfg?.pageId ?? "") || null;
    updateData.formId = String(cfg?.formId ?? "") || null;
    updateData.pageName = String(cfg?.pageName ?? "") || null;
    updateData.formName = String(cfg?.formName ?? "") || null;
    const rawFbId = cfg?.facebookAccountId ?? cfg?.accountId;
    updateData.facebookAccountId = typeof rawFbId === "number" && rawFbId > 0 ? rawFbId : null;
    // Keep the dedicated column and the destination table in sync together.
    twIdForSync = extractTargetWebsiteId(cfg);
    updateData.targetWebsiteId = twIdForSync;
  }
  await db.update(integrations).set(updateData).where(eq(integrations.id, id));
  // Dual-write: mirror the new targetWebsiteId into integration_destinations.
  // Undefined means "config was not part of this update" → leave the mapping
  // alone. A config update with no targetWebsiteId clears the mapping.
  if (twIdForSync !== undefined) {
    await safeSyncLegacyDestination(db, id, twIdForSync);
  }
}

export async function deleteIntegration(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // The FK on integration_destinations.integrationId CASCADEs, so the
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

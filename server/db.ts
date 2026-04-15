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
    process.env.MYSQL_URL,          // Railway internal TCP URL (preferred: more reliable inside Railway)
    process.env.MYSQL_PUBLIC_URL,  // Railway public TCP URL
    process.env.DATABASE_URL,       // Generic fallback
  ];

  for (const raw of candidates) {
    const url = raw?.trim();
    if (url && url.startsWith("mysql://")) {
      return url;
    }
  }

  // Last resort: return DATABASE_URL even if it's a socket (will fail gracefully)
  return process.env.DATABASE_URL?.trim();
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
        console.log("[Database] Connected via", url.startsWith("mysql://")
          ? url.replace(/:\/\/[^@]+@/, "://<credentials>@")
          : "(socket)");
      } catch (error) {
        console.warn("[Database] Failed to connect:", error);
        _db = null;
        _pool = null;
      }
    }
  }
  return _db;
}

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

export async function getLeadById(id: number): Promise<Lead | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return lead;
}

export async function getLeadStats(userId: number) {
  const db = await getDb();
  if (!db) return { total: 0, pending: 0, received: 0, failed: 0 };
  const [row] = await db
    .select({
      total: count(),
      pending: sql<number>`SUM(CASE WHEN (${leads.dataStatus} != 'ERROR' AND (${leads.dataStatus} = 'PENDING' OR (${leads.dataStatus} = 'ENRICHED' AND ${leads.deliveryStatus} IN ('PENDING','PROCESSING')))) THEN 1 ELSE 0 END)`,
      received: sql<number>`SUM(CASE WHEN ${leads.dataStatus} = 'ENRICHED' AND ${leads.deliveryStatus} = 'SUCCESS' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${leads.dataStatus} = 'ERROR' OR ${leads.deliveryStatus} IN ('FAILED','PARTIAL') THEN 1 ELSE 0 END)`,
    })
    .from(leads)
    .where(
      and(
        eq(leads.userId, userId),
        sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
      )
    );
  return row ?? { total: 0, pending: 0, received: 0, failed: 0 };
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

export async function createIntegration(data: {
  userId: number;
  type: "TELEGRAM" | "AFFILIATE" | "LEAD_ROUTING";
  name: string;
  config: unknown;
  telegramChatId?: string | null;
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
  await db.insert(integrations).values({
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
  });
}

export async function updateIntegration(id: number, data: Partial<{ name: string; config: unknown; isActive: boolean; telegramChatId: string | null }>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  // Keep dedicated columns in sync when config is updated
  const updateData: Record<string, unknown> = { ...data };
  if (data.config !== undefined) {
    const cfg = data.config as Record<string, unknown> | null;
    updateData.pageId = String(cfg?.pageId ?? "") || null;
    updateData.formId = String(cfg?.formId ?? "") || null;
    updateData.pageName = String(cfg?.pageName ?? "") || null;
    updateData.formName = String(cfg?.formName ?? "") || null;
    const rawFbId = cfg?.facebookAccountId ?? cfg?.accountId;
    updateData.facebookAccountId = typeof rawFbId === "number" && rawFbId > 0 ? rawFbId : null;
  }
  await db.update(integrations).set(updateData).where(eq(integrations.id, id));
}

export async function deleteIntegration(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
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

import { eq, desc, count, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  leads,
  orders,
  integrations,
  facebookConnections,
  webhookEvents,
  type Lead,
  type Order,
  type Integration,
  type FacebookConnection,
  type WebhookEvent,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
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
  formId?: string
): Promise<Lead[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(leads.userId, userId)];
  if (status) conditions.push(eq(leads.status, status));
  if (pageId) conditions.push(eq(leads.pageId, pageId));
  if (formId) conditions.push(eq(leads.formId, formId));
  if (search) {
    const like = `%${search}%`;
    conditions.push(
      sql`(${leads.fullName} LIKE ${like} OR ${leads.phone} LIKE ${like} OR ${leads.email} LIKE ${like} OR ${leads.leadgenId} LIKE ${like})`
    );
  }
  return db
    .select()
    .from(leads)
    .where(and(...conditions))
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
      pending: sql<number>`SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)`,
      received: sql<number>`SUM(CASE WHEN status = 'RECEIVED' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)`,
    })
    .from(leads)
    .where(eq(leads.userId, userId));
  return row ?? { total: 0, pending: 0, received: 0, failed: 0 };
}

export async function getLeadsCount(
  userId: number,
  search?: string,
  status?: "PENDING" | "RECEIVED" | "FAILED",
  pageId?: string,
  formId?: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const conditions = [eq(leads.userId, userId)];
  if (status) conditions.push(eq(leads.status, status));
  if (pageId) conditions.push(eq(leads.pageId, pageId));
  if (formId) conditions.push(eq(leads.formId, formId));
  if (search) {
    const like = `%${search}%`;
    conditions.push(
      sql`(${leads.fullName} LIKE ${like} OR ${leads.phone} LIKE ${like} OR ${leads.email} LIKE ${like} OR ${leads.leadgenId} LIKE ${like})`
    );
  }
  const [row] = await db.select({ count: count() }).from(leads).where(and(...conditions));
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
  if (!db) return { total: 0, sent: 0, failed: 0, pending: 0 };
  const [row] = await db
    .select({
      total: count(),
      sent: sql<number>`SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)`,
      pending: sql<number>`SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)`,
    })
    .from(orders)
    .where(eq(orders.userId, userId));
  return row ?? { total: 0, sent: 0, failed: 0, pending: 0 };
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
  const pageId = data.type === "LEAD_ROUTING" ? (String(cfg?.pageId ?? "") || null) : null;
  const formId = data.type === "LEAD_ROUTING" ? (String(cfg?.formId ?? "") || null) : null;
  const pageName = data.type === "LEAD_ROUTING" ? (String(cfg?.pageName ?? "") || null) : null;
  const formName = data.type === "LEAD_ROUTING" ? (String(cfg?.formName ?? "") || null) : null;
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
  }
  await db.update(integrations).set(updateData).where(eq(integrations.id, id));
}

export async function deleteIntegration(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(integrations).where(eq(integrations.id, id));
}

// ─── Facebook Connections ─────────────────────────────────────────────────────
export async function getFacebookConnections(userId: number): Promise<FacebookConnection[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(facebookConnections).where(eq(facebookConnections.userId, userId)).orderBy(desc(facebookConnections.createdAt));
}

export async function createFacebookConnection(data: {
  userId: number;
  pageId: string;
  pageName: string;
  accessToken: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(facebookConnections).values({ ...data, isActive: true });
}

export async function deleteFacebookConnection(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(facebookConnections).where(eq(facebookConnections.id, id));
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

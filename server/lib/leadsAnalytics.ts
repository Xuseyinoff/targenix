/**
 * server/lib/leadsAnalytics.ts
 *
 * Ready-to-use analytics queries against the denormalized leads table.
 * All queries are multi-tenant safe: every WHERE clause includes userId.
 * All queries use existing indexes — no full-table scans.
 */

import { eq, and, gte, desc, sql, count } from "drizzle-orm";
import { leads } from "../../drizzle/schema";
import { getDb } from "../db";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LeadsByPlatform {
  platform: string;
  total: number;
}

export interface LeadsByCampaign {
  campaignId:   string | null;
  campaignName: string | null;
  total: number;
}

export interface LeadsByDay {
  date:  string; // "YYYY-MM-DD"
  total: number;
}

export interface LeadsByForm {
  formId:   string;
  formName: string | null;
  pageId:   string;
  pageName: string | null;
  platform: string;
  total: number;
}

export interface LeadsByDeliveryStatus {
  deliveryStatus: string;
  total: number;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Leads count grouped by platform (fb / ig).
 * Uses: idx_leads_user_platform_created_at
 */
export async function getLeadsByPlatform(userId: number): Promise<LeadsByPlatform[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      platform: leads.platform,
      total: count(),
    })
    .from(leads)
    .where(eq(leads.userId, userId))
    .groupBy(leads.platform)
    .orderBy(desc(count()));

  return rows.map((r) => ({ platform: r.platform, total: Number(r.total) }));
}

/**
 * Leads count grouped by campaign, sorted by most leads.
 * Uses: idx_leads_user_campaign_id
 */
export async function getLeadsByCampaign(userId: number, limit = 20): Promise<LeadsByCampaign[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      campaignId:   leads.campaignId,
      campaignName: leads.campaignName,
      total: count(),
    })
    .from(leads)
    .where(eq(leads.userId, userId))
    .groupBy(leads.campaignId, leads.campaignName)
    .orderBy(desc(count()))
    .limit(limit);

  return rows.map((r) => ({
    campaignId:   r.campaignId,
    campaignName: r.campaignName,
    total: Number(r.total),
  }));
}

/**
 * Daily lead counts for the last N days.
 * Uses: idx_leads_user_created_at
 */
export async function getLeadsByDay(userId: number, days = 30): Promise<LeadsByDay[]> {
  const db = await getDb();
  if (!db) return [];

  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select({
      date:  sql<string>`DATE(${leads.createdAt})`,
      total: count(),
    })
    .from(leads)
    .where(and(eq(leads.userId, userId), gte(leads.createdAt, since)))
    .groupBy(sql`DATE(${leads.createdAt})`)
    .orderBy(sql`DATE(${leads.createdAt})`);

  return rows.map((r) => ({ date: r.date, total: Number(r.total) }));
}

/**
 * Top performing forms ranked by lead count.
 * Uses: idx_leads_user_page_status (partial)
 */
export async function getLeadsByForm(userId: number, limit = 20): Promise<LeadsByForm[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      formId:   leads.formId,
      formName: leads.formName,
      pageId:   leads.pageId,
      pageName: leads.pageName,
      platform: leads.platform,
      total: count(),
    })
    .from(leads)
    .where(eq(leads.userId, userId))
    .groupBy(leads.formId, leads.formName, leads.pageId, leads.pageName, leads.platform)
    .orderBy(desc(count()))
    .limit(limit);

  return rows.map((r) => ({
    formId:   r.formId,
    formName: r.formName,
    pageId:   r.pageId,
    pageName: r.pageName,
    platform: r.platform,
    total: Number(r.total),
  }));
}

/**
 * Leads count grouped by deliveryStatus (SUCCESS / FAILED / PARTIAL / …).
 * Uses: idx_leads_user_delivery_status
 */
export async function getLeadsByDeliveryStatus(userId: number): Promise<LeadsByDeliveryStatus[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      deliveryStatus: leads.deliveryStatus,
      total: count(),
    })
    .from(leads)
    .where(eq(leads.userId, userId))
    .groupBy(leads.deliveryStatus)
    .orderBy(desc(count()));

  return rows.map((r) => ({ deliveryStatus: r.deliveryStatus, total: Number(r.total) }));
}

/**
 * Full analytics snapshot — all metrics in one call.
 * Runs all queries in parallel.
 */
export async function getLeadsAnalytics(userId: number) {
  const [byPlatform, byCampaign, byDay, byForm, byDeliveryStatus] = await Promise.all([
    getLeadsByPlatform(userId),
    getLeadsByCampaign(userId),
    getLeadsByDay(userId, 30),
    getLeadsByForm(userId),
    getLeadsByDeliveryStatus(userId),
  ]);

  return { byPlatform, byCampaign, byDay, byForm, byDeliveryStatus };
}

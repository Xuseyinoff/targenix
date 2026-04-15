/**
 * adminLeadsRouter — Admin-only global leads explorer.
 *
 * Lists leads across all users with rich linkage:
 * user → lead (page/form) → deliveries (orders) → integration → destination (target website).
 */
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { integrations, leads, orders, targetWebsites, users } from "../../drizzle/schema";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { retryAllFailedLeads, retryStuckPendingLeads } from "../services/retryScheduler";

const AdminLeadListInput = z.object({
  limit: z.number().min(1).max(200).default(50),
  offset: z.number().min(0).default(0),
  /** Free-text search across lead + user fields */
  search: z.string().trim().min(1).max(200).optional(),
  userId: z.number().optional(),
  pageId: z.string().trim().min(1).max(128).optional(),
  formId: z.string().trim().min(1).max(128).optional(),
  integrationId: z.number().optional(),
  /** If true, only show leads with at least one delivery attempt (orders.attempts > 0) */
  onlyRouted: z.boolean().default(false),
});

type AdminLeadRow = {
  leadId: number;
  leadgenId: string;
  createdAt: Date;
  platform: "fb" | "ig";
  dataStatus: "PENDING" | "ENRICHED" | "ERROR";
  deliveryStatus: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "PARTIAL";
  fullName: string | null;
  phone: string | null;
  email: string | null;
  pageId: string;
  formId: string;
  pageName: string | null;
  formName: string | null;
  user: { id: number; name: string | null; email: string | null };
  deliveries: {
    total: number;
    sent: number;
    failed: number;
    pending: number;
    attemptsMax: number;
    lastOrderAt: Date | null;
    lastIntegrationId: number | null;
    lastIntegrationName: string | null;
    lastTargetWebsiteId: number | null;
    lastTargetWebsiteName: string | null;
  };
};

export const adminLeadsRouter = router({
  list: adminProcedure.input(AdminLeadListInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    const conditions = [];
    if (input.userId != null) conditions.push(eq(leads.userId, input.userId));
    if (input.pageId) conditions.push(eq(leads.pageId, input.pageId));
    if (input.formId) conditions.push(eq(leads.formId, input.formId));

    if (input.onlyRouted) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} AND ${orders.attempts} > 0)`
      );
    }

    if (input.integrationId != null) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} AND ${orders.integrationId} = ${input.integrationId})`
      );
    }

    if (input.search) {
      const like = `%${input.search}%`;
      conditions.push(
        or(
          sql`${leads.id} LIKE ${like}`,
          sql`${leads.leadgenId} LIKE ${like}`,
          sql`${leads.fullName} LIKE ${like}`,
          sql`${leads.phone} LIKE ${like}`,
          sql`${leads.email} LIKE ${like}`,
          sql`${leads.pageId} LIKE ${like}`,
          sql`${leads.formId} LIKE ${like}`,
          sql`${users.email} LIKE ${like}`,
          sql`${users.name} LIKE ${like}`,
          sql`${users.id} LIKE ${like}`,
        ),
      );
    }

    const whereClause = conditions.length ? and(...(conditions as [any, ...any[]])) : undefined;

    const [{ total }] = await db
      .select({ total: count() })
      .from(leads)
      .innerJoin(users, eq(users.id, leads.userId))
      .where(whereClause);

    const leadRows = await db
      .select({
        leadId: leads.id,
        leadgenId: leads.leadgenId,
        createdAt: leads.createdAt,
        platform: leads.platform,
        dataStatus: leads.dataStatus,
        deliveryStatus: leads.deliveryStatus,
        fullName: leads.fullName,
        phone: leads.phone,
        email: leads.email,
        pageId: leads.pageId,
        formId: leads.formId,
        pageName: leads.pageName,
        formName: leads.formName,
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
        deliveriesTotal: sql<number>`(SELECT COUNT(*) FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId})`,
        deliveriesSent: sql<number>`(SELECT COUNT(*) FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} AND ${orders.status} = 'SENT')`,
        deliveriesFailed: sql<number>`(SELECT COUNT(*) FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} AND ${orders.status} = 'FAILED')`,
        deliveriesPending: sql<number>`(SELECT COUNT(*) FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} AND ${orders.status} = 'PENDING')`,
        attemptsMax: sql<number>`(SELECT COALESCE(MAX(${orders.attempts}), 0) FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId})`,
        lastOrderAt: sql<Date | null>`(SELECT ${orders.updatedAt} FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} ORDER BY ${orders.updatedAt} DESC LIMIT 1)`,
        lastIntegrationId: sql<number | null>`(SELECT ${orders.integrationId} FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${leads.userId} ORDER BY ${orders.updatedAt} DESC LIMIT 1)`,
      })
      .from(leads)
      .innerJoin(users, eq(users.id, leads.userId))
      .where(whereClause)
      .orderBy(desc(leads.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    const lastIntegrationIds = Array.from(
      new Set(leadRows.map((r) => r.lastIntegrationId).filter((x): x is number => typeof x === "number")),
    );

    const integrationById = new Map<number, { name: string; targetWebsiteId: number | null }>();
    const targetWebsiteIds: number[] = [];

    if (lastIntegrationIds.length) {
      const ints = await db
        .select({ id: integrations.id, name: integrations.name, targetWebsiteId: integrations.targetWebsiteId })
        .from(integrations)
        .where(inArray(integrations.id, lastIntegrationIds));
      for (const i of ints) {
        integrationById.set(i.id, { name: i.name, targetWebsiteId: i.targetWebsiteId ?? null });
        if (i.targetWebsiteId) targetWebsiteIds.push(i.targetWebsiteId);
      }
    }

    const targetWebsiteById = new Map<number, { name: string }>();
    const uniqueTwIds = Array.from(new Set(targetWebsiteIds));
    if (uniqueTwIds.length) {
      const tws = await db
        .select({ id: targetWebsites.id, name: targetWebsites.name })
        .from(targetWebsites)
        .where(inArray(targetWebsites.id, uniqueTwIds));
      for (const tw of tws) targetWebsiteById.set(tw.id, { name: tw.name });
    }

    const rows: AdminLeadRow[] = leadRows.map((r) => {
      const intg = r.lastIntegrationId != null ? integrationById.get(r.lastIntegrationId) : undefined;
      const twId = intg?.targetWebsiteId ?? null;
      const tw = twId != null ? targetWebsiteById.get(twId) : undefined;

      return {
        leadId: r.leadId,
        leadgenId: r.leadgenId,
        createdAt: r.createdAt,
        platform: r.platform,
        dataStatus: r.dataStatus,
        deliveryStatus: r.deliveryStatus,
        fullName: r.fullName ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        pageId: r.pageId,
        formId: r.formId,
        pageName: r.pageName ?? null,
        formName: r.formName ?? null,
        user: { id: r.userId, name: r.userName ?? null, email: r.userEmail ?? null },
        deliveries: {
          total: Number(r.deliveriesTotal ?? 0),
          sent: Number(r.deliveriesSent ?? 0),
          failed: Number(r.deliveriesFailed ?? 0),
          pending: Number(r.deliveriesPending ?? 0),
          attemptsMax: Number(r.attemptsMax ?? 0),
          lastOrderAt: (r.lastOrderAt as unknown as Date | null) ?? null,
          lastIntegrationId: r.lastIntegrationId ?? null,
          lastIntegrationName: intg?.name ?? null,
          lastTargetWebsiteId: twId,
          lastTargetWebsiteName: tw?.name ?? null,
        },
      };
    });

    return { total: Number(total ?? 0), leads: rows };
  }),

  /**
   * Manually trigger the stuck-pending retry (for leads the worker failed to process).
   * This is idempotent — safe to call multiple times.
   */
  retryStuckPending: adminProcedure.mutation(async () => {
    const result = await retryStuckPendingLeads();
    return { retried: result.retried };
  }),

  /**
   * Trigger full retry — graph errors + stuck pending + due order deliveries.
   */
  retryAll: adminProcedure.mutation(async () => {
    const result = await retryAllFailedLeads();
    return { retried: result.retried };
  }),
});


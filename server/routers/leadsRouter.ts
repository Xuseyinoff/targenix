import { z } from "zod";
import { eq, and, inArray, desc, sql, count, or, gte, lt } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getLeads,
  getLeadById,
  getLeadStats,
  getLeadsCount,
  getOrdersByLeadId,
  getOrderStats,
  getTodayIntegrationLeadStats,
  getDb,
} from "../db";
import { leads, orders, integrations, targetWebsites, facebookForms, facebookConnections } from "../../drizzle/schema";
import { batchResolvePageFormDisplayNames, getUserFormsIndex, leadSourcePairKey } from "../services/facebookFormsService";
import { decrypt } from "../encryption";
import {
  fetchLeadsFromForm,
  extractLeadFields,
} from "../services/facebookService";
import {
  extractWithMappingForPoll,
  resolveLeadMappingFromConfig,
} from "../services/leadService";
import { dispatchLeadProcessing } from "../services/leadDispatch";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { getDashboardDayUtcBounds } from "../lib/dashboardTimezone";

export const leadsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        search: z.string().optional(),
        status: z.enum(["PENDING", "RECEIVED", "FAILED"]).optional(),
        pageId: z.string().optional(),
        formId: z.string().optional(),
        platform: z.enum(["fb", "ig"]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      // Platform filter: now resolved directly from leads.platform column (no extra query)
      // pageId/formId filters also use dedicated leads columns with indexes

      const [items, total] = await Promise.all([
        getLeads(userId, input.limit, input.offset, input.search, input.status, input.pageId, input.formId, undefined, input.platform),
        getLeadsCount(userId, input.search, input.status, input.pageId, input.formId, undefined, input.platform),
      ]);

      if (items.length === 0) return { items: [], total };

      // When leads.pageName / formName are null (webhook arrived before facebook_forms cache),
      // resolve from facebook_forms or LEAD_ROUTING integration columns.
      const displayNameByPair = await batchResolvePageFormDisplayNames(
        userId,
        items.map((l) => ({ pageId: l.pageId, formId: l.formId })),
      );
      const itemsWithNames = items.map((lead) => {
        const resolved = displayNameByPair.get(leadSourcePairKey(lead.pageId, lead.formId));
        return {
          ...lead,
          pageName: lead.pageName?.trim() ? lead.pageName : (resolved?.pageName ?? lead.pageName),
          formName: lead.formName?.trim() ? lead.formName : (resolved?.formName ?? lead.formName),
        };
      });

      // Batch-load orders for all leads in one query (eliminates N+1)
      const leadIds = itemsWithNames.map((l) => l.id);
      const allOrders = await db
        .select({
          id:            orders.id,
          leadId:        orders.leadId,
          integrationId: orders.integrationId,
          status:        orders.status,
          attempts:      orders.attempts,
          lastAttemptAt: orders.lastAttemptAt,
          nextRetryAt:   orders.nextRetryAt,
          createdAt:     orders.createdAt,
        })
        .from(orders)
        .where(and(eq(orders.userId, userId), inArray(orders.leadId, leadIds)));

      // Group orders by leadId
      const ordersByLead = new Map<number, typeof allOrders>();
      for (const order of allOrders) {
        const existing = ordersByLead.get(order.leadId) ?? [];
        existing.push(order);
        ordersByLead.set(order.leadId, existing);
      }

      const itemsWithOrders = itemsWithNames.map((lead) => ({
        ...lead,
        orders: ordersByLead.get(lead.id) ?? [],
      }));

      return { items: itemsWithOrders, total };
    }),

  // ── Get all pages+forms for filter dropdowns ────────────────────────────────
  getFormsIndex: protectedProcedure.query(async ({ ctx }) => {
    return getUserFormsIndex(ctx.user.id);
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const lead = await getLeadById(input.id, userId);
      if (!lead) {
        throw new Error("Lead not found");
      }
      const orders = await getOrdersByLeadId(input.id);
      const displayNameByPair = await batchResolvePageFormDisplayNames(userId, [
        { pageId: lead.pageId, formId: lead.formId },
      ]);
      const resolved = displayNameByPair.get(leadSourcePairKey(lead.pageId, lead.formId));
      const leadWithNames = {
        ...lead,
        pageName: lead.pageName?.trim() ? lead.pageName : (resolved?.pageName ?? lead.pageName),
        formName: lead.formName?.trim() ? lead.formName : (resolved?.formName ?? lead.formName),
      };
      return { lead: leadWithNames, orders };
    }),

  stats: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const [leadStats, orderStats, todayIntegrationLeads] = await Promise.all([
      getLeadStats(userId),
      getOrderStats(userId),
      getTodayIntegrationLeadStats(userId),
    ]);
    return { leads: leadStats, orders: orderStats, todayIntegrationLeads };
  }),

  // ── Retry a single FAILED lead ──────────────────────────────────────────────
  retryLead: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, input.id), eq(leads.userId, userId)))
        .limit(1);

      if (!lead) throw new Error("Lead not found");
      const retryable =
        lead.dataStatus === "ERROR" ||
        lead.deliveryStatus === "FAILED" ||
        lead.deliveryStatus === "PARTIAL";
      if (!retryable) throw new Error("Only leads with Graph errors or failed/partial delivery can be retried");

      await db
        .update(leads)
        .set({ dataStatus: "PENDING", deliveryStatus: "PENDING", dataError: null })
        .where(eq(leads.id, lead.id));

      // Re-run lead processing via queue
      void dispatchLeadProcessing({
        leadId: lead.id,
        leadgenId: lead.leadgenId,
        pageId: lead.pageId,
        formId: lead.formId,
        userId: lead.userId,
      }).catch((err) => console.error(`[RetryLead] lead ${lead.id} error:`, err));

      return { ok: true, leadId: lead.id };
    }),

  // ── Retry all FAILED leads for this user ─────────────────────────────────
  retryAllFailed: protectedProcedure
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const failedLeads = await db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.userId, userId),
            or(
              eq(leads.dataStatus, "ERROR"),
              inArray(leads.deliveryStatus, ["FAILED", "PARTIAL"])
            ),
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
          )
        );

      if (failedLeads.length === 0) return { retried: 0 };

      await db
        .update(leads)
        .set({ dataStatus: "PENDING", deliveryStatus: "PENDING", dataError: null })
        .where(
          and(
            eq(leads.userId, userId),
            or(
              eq(leads.dataStatus, "ERROR"),
              inArray(leads.deliveryStatus, ["FAILED", "PARTIAL"])
            ),
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
          )
        );

      // Re-process each lead via queue
      for (const lead of failedLeads) {
        void dispatchLeadProcessing({
          leadId: lead.id,
          leadgenId: lead.leadgenId,
          pageId: lead.pageId,
          formId: lead.formId,
          userId: lead.userId,
        }).catch((err) => console.error(`[RetryAllFailed] lead ${lead.id} error:`, err));
      }

      console.log(`[RetryAllFailed] Retrying ${failedLeads.length} failed leads for user ${userId}`);
      return { retried: failedLeads.length };
    }),

  // ── Get single lead with enriched orders ──────────────────────────────────
  getDetail: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, input.id), eq(leads.userId, userId)))
        .limit(1);

      if (!lead) throw new Error("Lead not found");

      // Verify this lead was actually routed for this user (same visibility rule as Leads page)
      const [exists] = await db
        .select({ n: sql<number>`1` })
        .from(orders)
        .where(and(eq(orders.leadId, lead.id), eq(orders.userId, userId), sql`${orders.attempts} > 0`))
        .limit(1);
      if (!exists) throw new Error("Lead not found");

      // Fetch orders — scope to both leadId AND userId for defense-in-depth
      const orderRows = await db
        .select()
        .from(orders)
        .where(and(eq(orders.leadId, input.id), eq(orders.userId, userId)))
        .orderBy(orders.createdAt);

      // Enrich each order with integration name, type, and target website
      const enrichedOrders = await Promise.all(
        orderRows.map(async (order) => {
          // Include userId filter: prevents reading another user's integration details
          // if an order's integrationId were ever mismatched.
          const [intg] = await db
            .select({
              id: integrations.id,
              name: integrations.name,
              type: integrations.type,
              targetWebsiteId: integrations.targetWebsiteId,
              config: integrations.config,
            })
            .from(integrations)
            .where(and(eq(integrations.id, order.integrationId), eq(integrations.userId, userId)))
            .limit(1);

          let targetWebsiteName: string | null = null;
          let targetWebsiteUrl: string | null = null;

          if (intg) {
            const cfg = intg.config as Record<string, unknown>;
            const twId = intg.targetWebsiteId ?? (cfg.targetWebsiteId ? Number(cfg.targetWebsiteId) : null);
            if (twId) {
              const [tw] = await db
                .select({ name: targetWebsites.name, url: targetWebsites.url })
                .from(targetWebsites)
                .where(eq(targetWebsites.id, twId))
                .limit(1);
              targetWebsiteName = tw?.name ?? null;
              targetWebsiteUrl = tw?.url ?? null;
            }
          }

          return {
            id: order.id,
            leadId: order.leadId,
            userId: order.userId,
            integrationId: order.integrationId,
            status: order.status,
            attempts:      order.attempts,
            lastAttemptAt: order.lastAttemptAt,
            nextRetryAt:   order.nextRetryAt,
            responseData: order.responseData as Record<string, unknown> | null,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            integrationName: intg?.name ?? "Unknown Integration",
            integrationType: intg?.type ?? null,
            targetWebsiteName: targetWebsiteName,
            targetWebsiteUrl: targetWebsiteUrl,
          };
        })
      );

      return { lead, orders: enrichedOrders };
    }),

  pollFromForm: protectedProcedure
    .input(
      z.object({
        formId: z.string().min(1, "Form ID is required"),
        pageId: z.string().min(1, "Page ID is required"),
        /** Only sync leads newer than now - hoursBack */
        hoursBack: z.number().min(1).max(720).default(24),
      })
    )
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "pollFromForm", { max: 3, windowMs: 60_000, message: "Too many poll requests. Max 3 per minute." });
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [connection] = await db
        .select()
        .from(facebookConnections)
        .where(and(
          eq(facebookConnections.userId, userId),
          eq(facebookConnections.pageId, input.pageId),
          eq(facebookConnections.isActive, true),
        ))
        .orderBy(desc(facebookConnections.createdAt))
        .limit(1);
      if (!connection) {
        throw new Error(
          `No Facebook connection found for Page ID: ${input.pageId}. Please connect the page via Facebook Accounts.`
        );
      }

      const accessToken = decrypt(connection.accessToken);
      const polledLeads = await fetchLeadsFromForm(input.formId, accessToken, { hoursBack: input.hoursBack });

      if (polledLeads.length === 0) {
        return { synced: 0, skipped: 0, message: "No leads found in this form." };
      }

      // Load LEAD_ROUTING integration config for this page+form to derive the
      // right nameField / phoneField. This path used to read ONLY the legacy
      // flat shape (`config.nameField`, `config.phoneField`), which meant
      // V2-wizard-created integrations that store their mapping under
      // `config.fieldMappings` were silently ignored here — producing empty
      // leads after a Graph poll. `resolveLeadMappingFromConfig` implements
      // the exact same dual-read precedence as `processLead`, so poll and
      // webhook paths now agree on which field feeds which lead column.
      const [routingIntg] = await db
        .select({ config: integrations.config })
        .from(integrations)
        .where(
          and(
            eq(integrations.userId, userId),
            eq(integrations.type, "LEAD_ROUTING"),
            eq(integrations.pageId, input.pageId),
            eq(integrations.formId, input.formId),
          )
        )
        .limit(1);

      const { nameField, phoneField } = resolveLeadMappingFromConfig(
        routingIntg?.config as Record<string, unknown> | null | undefined,
      );

      let synced = 0;
      let skipped = 0;

      for (const item of polledLeads) {
        // Must filter by BOTH leadgenId AND userId — two users can legitimately own
        // the same Facebook lead (composite unique index on schema).
        // Without userId, User B's lead is skipped if User A already polled it.
        const existing = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.leadgenId, item.id), eq(leads.userId, userId)))
          .limit(1);

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        const fields = nameField || phoneField
          ? extractWithMappingForPoll(item.field_data ?? [], nameField, phoneField)
          : extractLeadFields(item.field_data ?? []);

        await db.insert(leads).values({
          userId,
          pageId: input.pageId,
          formId: item.form_id || input.formId,
          leadgenId: item.id,
          rawData: item,
          fullName: fields.fullName,
          phone: fields.phone,
          email: fields.email,
          dataStatus: "ENRICHED",
          deliveryStatus: "PENDING",
        });

        const [saved] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.leadgenId, item.id), eq(leads.userId, userId)))
          .limit(1);

        if (saved) {
          void dispatchLeadProcessing({
            leadId: saved.id,
            leadgenId: item.id,
            pageId: input.pageId,
            formId: item.form_id || input.formId,
            userId,
          }).catch((err) => console.error("[PollLeads] dispatchLeadProcessing error:", err));
        }

        synced++;
      }

      console.log(`[PollLeads] Form ${input.formId}: synced=${synced} skipped=${skipped}`);

      return {
        synced,
        skipped,
        message: `${synced} new lead(s) synced, ${skipped} duplicate(s) skipped.`,
      };
    }),

  // ── Time-series lead counts (hourly for today, daily for 7d/30d) ──────────
  getTimeSeries: protectedProcedure
    .input(z.object({
      range: z.enum(["today", "last_7d", "last_30d"]).default("last_7d"),
    }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return { points: [], range: input.range };

      const todayBounds = getDashboardDayUtcBounds();

      if (input.range === "today") {
        const rows = await db
          .select({
            hour: sql<number>`HOUR(CONVERT_TZ(${leads.createdAt}, '+00:00', '+05:00'))`,
            total: sql<number>`COUNT(*)`,
            sent: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'SUCCESS' THEN 1 ELSE 0 END)`,
            failed: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'FAILED' THEN 1 ELSE 0 END)`,
          })
          .from(leads)
          .where(and(
            eq(leads.userId, userId),
            gte(leads.createdAt, todayBounds.start),
            lt(leads.createdAt, todayBounds.end),
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
          ))
          .groupBy(sql`HOUR(CONVERT_TZ(${leads.createdAt}, '+00:00', '+05:00'))`)
          .orderBy(sql`HOUR(CONVERT_TZ(${leads.createdAt}, '+00:00', '+05:00'))`);

        const byHour = new Map(rows.map((r) => [Number(r.hour), r]));
        const points = Array.from({ length: 24 }, (_, h) => ({
          label: `${String(h).padStart(2, "0")}:00`,
          total: Number(byHour.get(h)?.total ?? 0),
          sent: Number(byHour.get(h)?.sent ?? 0),
          failed: Number(byHour.get(h)?.failed ?? 0),
        }));
        return { points, range: input.range };
      }

      const days = input.range === "last_7d" ? 7 : 30;
      const startDate = new Date(todayBounds.start.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          day: sql<string>`DATE(CONVERT_TZ(${leads.createdAt}, '+00:00', '+05:00'))`,
          total: sql<number>`COUNT(*)`,
          sent: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'SUCCESS' THEN 1 ELSE 0 END)`,
          failed: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'FAILED' THEN 1 ELSE 0 END)`,
        })
        .from(leads)
        .where(and(
          eq(leads.userId, userId),
          gte(leads.createdAt, startDate),
          sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
        ))
        .groupBy(sql`DATE(CONVERT_TZ(${leads.createdAt}, '+00:00', '+05:00'))`)
        .orderBy(sql`DATE(CONVERT_TZ(${leads.createdAt}, '+00:00', '+05:00'))`);

      const byDay = new Map(rows.map((r) => [r.day, r]));
      const points = Array.from({ length: days }, (_, i) => {
        const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
        // Add 5h offset to get Tashkent local date
        const tashkentD = new Date(d.getTime() + 5 * 60 * 60 * 1000);
        const dayStr = tashkentD.toISOString().slice(0, 10);
        return {
          label: dayStr.slice(5), // "MM-DD"
          total: Number(byDay.get(dayStr)?.total ?? 0),
          sent: Number(byDay.get(dayStr)?.sent ?? 0),
          failed: Number(byDay.get(dayStr)?.failed ?? 0),
        };
      });
      return { points, range: input.range };
    }),

  // ── Top lead sources (page/form breakdown) ───────────────────────────────
  getTopSources: protectedProcedure
    .input(z.object({
      range: z.enum(["today", "last_7d", "last_30d"]).default("last_7d"),
    }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return [];

      const todayBounds = getDashboardDayUtcBounds();
      const startDate =
        input.range === "today" ? todayBounds.start :
        input.range === "last_7d" ? new Date(todayBounds.start.getTime() - 6 * 24 * 60 * 60 * 1000) :
        new Date(todayBounds.start.getTime() - 29 * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          pageId: leads.pageId,
          formId: leads.formId,
          pageName: leads.pageName,
          formName: leads.formName,
          total: sql<number>`COUNT(*)`,
          sent: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'SUCCESS' THEN 1 ELSE 0 END)`,
          failed: sql<number>`SUM(CASE WHEN ${leads.deliveryStatus} = 'FAILED' THEN 1 ELSE 0 END)`,
        })
        .from(leads)
        .where(and(
          eq(leads.userId, userId),
          gte(leads.createdAt, startDate),
          sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.leadId} = ${leads.id} AND ${orders.userId} = ${userId} AND ${orders.attempts} > 0)`
        ))
        .groupBy(leads.pageId, leads.formId, leads.pageName, leads.formName)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(8);

      return rows.map((r) => ({
        pageId: r.pageId,
        formId: r.formId,
        label: (r.formName?.trim() || r.pageName?.trim() || r.formId).slice(0, 32),
        total: Number(r.total),
        sent: Number(r.sent),
        failed: Number(r.failed),
      }));
    }),

  // ── Delivery performance per integration ─────────────────────────────────
  getDeliveryStats: protectedProcedure
    .input(z.object({
      range: z.enum(["today", "last_7d", "last_30d"]).default("last_7d"),
    }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return [];

      const todayBounds = getDashboardDayUtcBounds();
      const startDate =
        input.range === "today" ? todayBounds.start :
        input.range === "last_7d" ? new Date(todayBounds.start.getTime() - 6 * 24 * 60 * 60 * 1000) :
        new Date(todayBounds.start.getTime() - 29 * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          integrationId: orders.integrationId,
          total: sql<number>`COUNT(*)`,
          sent: sql<number>`SUM(CASE WHEN ${orders.status} = 'SENT' THEN 1 ELSE 0 END)`,
          failed: sql<number>`SUM(CASE WHEN ${orders.status} = 'FAILED' THEN 1 ELSE 0 END)`,
        })
        .from(orders)
        .where(and(eq(orders.userId, userId), gte(orders.createdAt, startDate)))
        .groupBy(orders.integrationId)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(8);

      if (rows.length === 0) return [];

      const integrationIds = rows.map((r) => r.integrationId);
      const intgRows = await db
        .select({ id: integrations.id, name: integrations.name, type: integrations.type })
        .from(integrations)
        .where(and(eq(integrations.userId, userId), inArray(integrations.id, integrationIds)));

      const intgMap = new Map(intgRows.map((i) => [i.id, i]));

      return rows.map((r) => {
        const total = Number(r.total);
        const sent = Number(r.sent);
        const intg = intgMap.get(r.integrationId);
        return {
          integrationId: r.integrationId,
          name: intg?.name ?? `Integration #${r.integrationId}`,
          type: intg?.type ?? null,
          total,
          sent,
          failed: Number(r.failed),
          successRate: total > 0 ? Math.round((sent / total) * 100) : 0,
        };
      });
    }),
});

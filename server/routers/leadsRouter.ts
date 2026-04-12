import { z } from "zod";
import { eq, and, inArray, desc, sql, count, or } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getLeads,
  getLeadById,
  getLeadStats,
  getLeadsCount,
  getOrdersByLeadId,
  getOrderStats,
  getTodayIntegrationLeadStats,
  getFacebookConnections,
  getDb,
} from "../db";
import { leads, orders, integrations, targetWebsites, facebookForms } from "../../drizzle/schema";
import { getLeadSourceInfo, getUserFormsIndex } from "../services/facebookFormsService";
import { decrypt } from "../encryption";
import {
  fetchLeadsFromForm,
  extractLeadFields,
} from "../services/facebookService";
import { extractWithMappingForPoll } from "../services/leadService";
import { processLead } from "../services/leadService";

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

      // Batch-load orders for all leads in one query (eliminates N+1)
      const leadIds = items.map((l) => l.id);
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

      // pageName/formName/platform are now denormalized in leads table — no extra queries
      const itemsWithOrders = items.map((lead) => ({
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
      const lead = await getLeadById(input.id);
      if (!lead || lead.userId !== userId) {
        throw new Error("Lead not found");
      }
      const orders = await getOrdersByLeadId(input.id);
      return { lead, orders };
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

      // Re-run lead processing (non-blocking)
      setImmediate(() => {
        processLead({
          leadId: lead.id,
          leadgenId: lead.leadgenId,
          pageId: lead.pageId,
          formId: lead.formId,
          userId: lead.userId,
        }).catch((err) => console.error(`[RetryLead] lead ${lead.id} error:`, err));
      });

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
            )
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
            )
          )
        );

      // Re-process each lead
      for (const lead of failedLeads) {
        setImmediate(() => {
          processLead({
            leadId: lead.id,
            leadgenId: lead.leadgenId,
            pageId: lead.pageId,
            formId: lead.formId,
            userId: lead.userId,
          }).catch((err) => console.error(`[RetryAllFailed] lead ${lead.id} error:`, err));
        });
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const connections = await getFacebookConnections(userId);
      const connection = connections.find((c) => c.pageId === input.pageId);
      if (!connection) {
        throw new Error(
          `No Facebook connection found for Page ID: ${input.pageId}. Please add it in FB Connections.`
        );
      }

      const accessToken = decrypt(connection.accessToken);
      const polledLeads = await fetchLeadsFromForm(input.formId, accessToken);

      if (polledLeads.length === 0) {
        return { synced: 0, skipped: 0, message: "No leads found in this form." };
      }

      // Load LEAD_ROUTING integration config for this page+form to use nameField/phoneField
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

      const routingCfg = (routingIntg?.config ?? {}) as Record<string, unknown>;
      const nameField = routingCfg.nameField as string | undefined;
      const phoneField = routingCfg.phoneField as string | undefined;

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
          .where(eq(leads.leadgenId, item.id))
          .limit(1);

        if (saved) {
          setImmediate(() => {
            processLead({
              leadId: saved.id,
              leadgenId: item.id,
              pageId: input.pageId,
              formId: item.form_id || input.formId,
              userId,
            }).catch((err) =>
              console.error("[PollLeads] processLead error:", err)
            );
          });
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
});

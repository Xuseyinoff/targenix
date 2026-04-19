import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  getDb,
} from "../db";
import { sendAffiliateOrderByTemplate, sendLeadViaTemplate, type TemplateType, type TemplateConfig } from "../services/affiliateService";
import { sendLeadTelegramNotification } from "../services/leadService";
import { targetWebsites, destinationTemplates } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { checkUserRateLimit } from "../lib/userRateLimit";

export const integrationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const list = await getIntegrations(ctx.user.id);
    const db = await getDb();
    if (!db) return list;
    // Enrich LEAD_ROUTING integrations with targetWebsiteName from DB (using dedicated column)
    return Promise.all(
      list.map(async (integration) => {
        if (integration.type !== "LEAD_ROUTING") return integration;
        const cfg = integration.config as Record<string, unknown>;
        const twId = integration.targetWebsiteId ?? (cfg?.targetWebsiteId ? Number(cfg.targetWebsiteId) : null);
        if (!twId) return integration;
        const [tw] = await db
          .select({ id: targetWebsites.id, name: targetWebsites.name })
          .from(targetWebsites)
          .where(and(eq(targetWebsites.id, twId), eq(targetWebsites.userId, ctx.user.id)))
          .limit(1);
        return { ...integration, targetWebsiteName: tw?.name ?? (cfg?.targetWebsiteName as string | undefined) ?? null };
      })
    );
  }),

  /**
   * Lead Routing wizard only. Standalone Affiliate integrations were removed from the product UI;
   * delivery code still supports legacy AFFILIATE rows in the database.
   */
  create: protectedProcedure
    .input(
      z.object({
        type: z.literal("LEAD_ROUTING"),
        name: z.string().min(1).max(255),
        config: z.record(z.string(), z.any()),
        telegramChatId: z.string().max(64).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await createIntegration({
        userId: ctx.user.id,
        type: input.type,
        name: input.name,
        config: input.config,
        telegramChatId: input.telegramChatId ?? null,
      });
      return { success: true };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        config: z.record(z.string(), z.any()).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const list = await getIntegrations(ctx.user.id);
      const owned = list.find((i) => i.id === input.id);
      if (!owned) throw new Error("Integration not found");
      const { id, ...data } = input;
      await updateIntegration(id, data);
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const list = await getIntegrations(ctx.user.id);
      const owned = list.find((i) => i.id === input.id);
      if (!owned) throw new Error("Integration not found");
      await deleteIntegration(input.id);
      return { success: true };
    }),

  toggle: protectedProcedure
    .input(z.object({ id: z.number(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const list = await getIntegrations(ctx.user.id);
      const owned = list.find((i) => i.id === input.id);
      if (!owned) throw new Error("Integration not found");
      await updateIntegration(input.id, { isActive: input.isActive });
      return { success: true };
    }),

  testLead: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "testLead", { max: 5, windowMs: 60_000, message: "Too many test requests. Max 5 per minute." });
      const list = await getIntegrations(ctx.user.id);
      const integration = list.find((i) => i.id === input.id);
      if (!integration) throw new Error("Integration not found");
      if (integration.type !== "LEAD_ROUTING") {
        throw new Error("Test lead is only supported for Lead Routing integrations");
      }
      const config = integration.config as Record<string, unknown>;
      const variableFields = (config.variableFields as Record<string, string> | undefined) ?? {};

      // Synthetic test lead payload
      // Use dedicated columns (indexed) with config JSON as fallback
      const testLead = {
        leadgenId: "test-lead-000",
        fullName: "Test Foydalanuvchi",
        phone: "+998901234567",
        email: "test@targenix.uz",
        pageId: integration.pageId ?? "test-page",
        formId: integration.formId ?? "test-form",
        createdAt: new Date(),
      };

      let success = false;
      let responseData: unknown = null;
      let errorMsg: string | undefined;
      let durationMs = 0;

      const t0 = Date.now();
      try {
        const twId = integration.targetWebsiteId ?? (config.targetWebsiteId ? Number(config.targetWebsiteId) : null);
        if (twId) {
          const db = await getDb();
          if (!db) throw new Error("Database not available");
          const [tw] = await db
            .select()
            .from(targetWebsites)
            .where(and(eq(targetWebsites.id, twId), eq(targetWebsites.userId, ctx.user.id)))
            .limit(1);
          if (!tw) throw new Error("Target website not found or not owned by you");

          let result: { success: boolean; responseData?: unknown; error?: string };
          if (tw.templateId) {
            // Admin template-based destination → use sendLeadViaTemplate
            const [dynTpl] = await db
              .select()
              .from(destinationTemplates)
              .where(eq(destinationTemplates.id, tw.templateId))
              .limit(1);
            if (!dynTpl) throw new Error(`Destination template #${tw.templateId} not found`);
            result = await sendLeadViaTemplate(dynTpl, tw.templateConfig, testLead, variableFields);
          } else {
            // Legacy custom/sotuvchi/100k destination
            result = await sendAffiliateOrderByTemplate(
              tw.templateType as TemplateType,
              tw.templateConfig as TemplateConfig,
              testLead,
              variableFields,
              tw.url ?? ""
            );
          }
          success = result.success;
          responseData = result.responseData;
          errorMsg = result.error;
        } else {
          throw new Error("No target website configured for this integration");
        }
      } catch (err) {
        success = false;
        errorMsg = err instanceof Error ? err.message : String(err);
      }
      durationMs = Date.now() - t0;

      // Send Telegram notification with [TEST] badge — same format as real leads
      void sendLeadTelegramNotification({
        integration: {
          userId: integration.userId,
          telegramChatId: null,
          name: integration.name,
          type: integration.type,
        },
        userId: ctx.user.id,
        lead: {
          fullName: testLead.fullName,
          phone: testLead.phone,
          email: testLead.email,
          pageId: testLead.pageId,
          formId: testLead.formId,
          leadgenId: testLead.leadgenId,
        },
        result: { success, responseData, error: errorMsg, durationMs },
        isTest: true,
      }).catch(() => { /* non-critical */ });

      return { success, responseData, error: errorMsg, durationMs };
    }),
});

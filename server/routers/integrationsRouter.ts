import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  getDb,
} from "../db";
import { inArray } from "drizzle-orm";
import { injectVariables } from "../services/affiliateService";
import { sendLeadTelegramNotification } from "../services/leadService";
import { sendTelegramRawMessage } from "../services/telegramService";
import { decrypt } from "../encryption";
import { targetWebsites, type TargetWebsite } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { getAdapter } from "../integrations";
import { resolveIntegrationDestinations } from "../services/integrationDestinations";
import type { DbClient } from "../db";

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
        /**
         * Ordered list of destination IDs to fan-out to (Commit 6c).
         * When provided, `integration_destinations` is populated with the
         * full list instead of only the single id embedded in config.
         * The first entry also sets `integrations.targetWebsiteId` for
         * legacy compat (dispatch falls back to that column when the flag
         * is off).
         * Max 20 destinations per integration — reasonable upper bound that
         * prevents accidentally passing a large array.
         */
        destinationIds: z.array(z.number().int().positive()).max(20).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Ownership guard: ensure every destinationId belongs to this user.
      // The wizard only surfaces owned destinations, so a mismatch here
      // indicates a tampering attempt — silently filter to owned IDs.
      let safeDestinationIds = input.destinationIds;
      if (safeDestinationIds && safeDestinationIds.length > 0) {
        const db = await getDb();
        if (db) {
          const { targetWebsites } = await import("../../drizzle/schema");
          const owned = await db
            .select({ id: targetWebsites.id })
            .from(targetWebsites)
            .where(
              inArray(targetWebsites.id, safeDestinationIds),
            );
          const ownedSet = new Set(owned.map((r) => r.id));
          // Preserve original ordering; drop ids not owned by this user.
          safeDestinationIds = safeDestinationIds.filter((id) => ownedSet.has(id));
        }
      }

      await createIntegration({
        userId: ctx.user.id,
        type: input.type,
        name: input.name,
        config: input.config,
        telegramChatId: input.telegramChatId ?? null,
        destinationIds: safeDestinationIds,
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
        /**
         * Stage B opt-in: when provided, `integration_destinations` is
         * rewritten to this exact ordered list and the legacy
         * `integrations.targetWebsiteId` is set to the first id.
         *
         * Omitting the field preserves the pre-Stage-B behaviour for every
         * existing caller (classic routing wizard, toggle, rename). The new
         * V2 wizard will start sending this field when it grows an edit
         * flow — then and only then does the join table get rewritten.
         *
         * Max 20 destinations per integration — same upper bound enforced
         * on `create`, prevents accidental large arrays.
         */
        destinationIds: z.array(z.number().int().positive()).max(20).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const list = await getIntegrations(ctx.user.id);
      const owned = list.find((i) => i.id === input.id);
      if (!owned) throw new Error("Integration not found");

      // Ownership guard: when an explicit destinationIds list is passed,
      // ensure every id belongs to this user. Mirrors the guard in
      // `create` — silently filters out non-owned ids so a tampering
      // attempt cannot reach into another tenant's destinations.
      let safeDestinationIds = input.destinationIds;
      if (safeDestinationIds && safeDestinationIds.length > 0) {
        const db = await getDb();
        if (db) {
          const { targetWebsites } = await import("../../drizzle/schema");
          const ownedRows = await db
            .select({ id: targetWebsites.id })
            .from(targetWebsites)
            .where(inArray(targetWebsites.id, safeDestinationIds));
          const ownedSet = new Set(ownedRows.map((r) => r.id));
          safeDestinationIds = safeDestinationIds.filter((id) =>
            ownedSet.has(id),
          );
        }
      }

      const { id, ...rest } = input;
      // Overwrite with the ownership-filtered list so the CRUD layer never
      // sees the raw (possibly tampered) input.
      await updateIntegration(id, {
        ...rest,
        destinationIds: safeDestinationIds,
      });
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

      // Synthetic test lead payload — identical shape to every other code
      // path so adapters receive the same LeadPayload they'd get in prod.
      const testLead = {
        leadgenId: "test-lead-000",
        fullName: "Test Foydalanuvchi",
        phone: "+998901234567",
        email: "test@targenix.uz",
        pageId: integration.pageId ?? "test-page",
        formId: integration.formId ?? "test-form",
      };
      const testLeadTimestamp = new Date();

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fan-out: resolve EVERY destination the integration is wired to
      // (multi-destination users get the full list; legacy single-dest
      // users get an array of one). Matches the runtime delivery path so
      // "Test lead" is a real dry-run of what production would do — fixes
      // the old behaviour where only the primary `targetWebsiteId` got
      // exercised and the other N-1 destinations stayed untested.
      const destinations = await resolveIntegrationDestinations(db, {
        id: integration.id,
        userId: integration.userId,
        targetWebsiteId: integration.targetWebsiteId,
        config: integration.config,
      });

      if (destinations.length === 0) {
        throw new Error("No destinations configured for this integration");
      }

      // Run all deliveries sequentially — keeps log output deterministic
      // and avoids bursting the same Telegram bot / webhook endpoint in
      // parallel during a test. Small N (≤20 enforced at create) so total
      // wall time stays well under the tRPC timeout.
      const perDestinationResults: Array<{
        destinationId: number;
        name: string;
        success: boolean;
        responseData?: unknown;
        error?: string;
        durationMs: number;
      }> = [];

      for (const d of destinations) {
        const tStart = Date.now();
        let r: { success: boolean; responseData?: unknown; error?: string };
        try {
          r = await sendTestLeadToDestination({
            db,
            tw: d.targetWebsite,
            testLead,
            testLeadTimestamp,
            variableFields,
            userId: ctx.user.id,
          });
        } catch (err) {
          r = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        perDestinationResults.push({
          destinationId: d.targetWebsite.id,
          name: d.targetWebsite.name,
          success: r.success,
          responseData: r.responseData,
          error: r.error,
          durationMs: Date.now() - tStart,
        });
      }

      // Aggregate fields keep the existing client contract intact:
      //   - `success` is true only when EVERY destination accepted the test
      //   - `error` surfaces the first failure so the existing toast still
      //     tells the user what went wrong
      //   - `responseData` / `durationMs` mirror the first-destination
      //     values to preserve today's single-dest behaviour; the full
      //     per-destination breakdown lives in the new `results` array so
      //     richer UIs can opt in later without a tRPC contract break.
      const success = perDestinationResults.every((r) => r.success);
      const firstFailure = perDestinationResults.find((r) => !r.success);
      const errorMsg = firstFailure?.error;
      const responseData = perDestinationResults[0]?.responseData ?? null;
      const durationMs = perDestinationResults.reduce(
        (acc, r) => acc + r.durationMs,
        0,
      );

      // Telegram notification: one message per integration, not per
      // destination — we already fan out live leads to N destinations and
      // send ONE Telegram summary, so mirroring that keeps "[TEST]"
      // notifications quiet and the format unchanged.
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

      return {
        success,
        responseData,
        error: errorMsg,
        durationMs,
        results: perDestinationResults,
      };
    }),
});

/**
 * Dispatch a synthetic test lead to a SINGLE resolved destination.
 *
 * Mirrors the adapter-routing logic that lived inline in `testLead` before
 * this helper existed — extracting it lets the fan-out loop call it once
 * per destination without duplicating the Telegram `[TEST]` prefix, the
 * Google Sheets extraFields shim, or the dynamic-template bridge.
 *
 * Returns a normalised `{ success, responseData?, error? }` — the caller is
 * responsible for timing and aggregating.
 */
async function sendTestLeadToDestination(args: {
  db: DbClient;
  tw: TargetWebsite;
  testLead: {
    leadgenId: string;
    fullName: string;
    phone: string;
    email: string;
    pageId: string;
    formId: string;
  };
  testLeadTimestamp: Date;
  variableFields: Record<string, string>;
  userId: number;
}): Promise<{ success: boolean; responseData?: unknown; error?: string }> {
  const { db, tw, testLead, testLeadTimestamp, variableFields, userId } = args;

  if (tw.templateId) {
    // Admin template-based destination → dynamicTemplateAdapter (resolves template from DB).
    const adapter = getAdapter("dynamic-template");
    if (!adapter) throw new Error("Adapter not found: dynamic-template");
    return adapter.send(
      { db, targetWebsite: tw, variableFields },
      testLead,
    );
  }

  if (tw.templateType === "telegram") {
    // Preserve the "[TEST]" message prefix — this is the only cue users
    // have that a test message isn't a real lead, so it MUST stay.
    const cfg = (tw.templateConfig ?? {}) as {
      botTokenEncrypted?: string;
      chatId?: string;
      messageTemplate?: string;
    };
    if (!cfg.botTokenEncrypted || !cfg.chatId) {
      return {
        success: false,
        error: "Telegram destination missing botToken or chatId",
      };
    }
    const token = decrypt(cfg.botTokenEncrypted);
    const templateCtx: Record<string, string> = {
      full_name: testLead.fullName,
      phone_number: testLead.phone,
      email: testLead.email,
      pageName: "",
      formName: "",
      campaignName: "",
      createdAt: testLeadTimestamp.toLocaleString("uz-UZ"),
    };
    const messageTemplate =
      cfg.messageTemplate ||
      "📋 Yangi lead\n\n👤 Ism: {{full_name}}\n📞 Telefon: {{phone_number}}\n📧 Email: {{email}}";
    const message = `[TEST] ${injectVariables(messageTemplate, templateCtx)}`;
    return sendTelegramRawMessage(token, cfg.chatId, message);
  }

  if (tw.templateType === "google-sheets") {
    const adapter = getAdapter("google-sheets");
    if (!adapter) throw new Error("Adapter not found: google-sheets");
    return adapter.send(
      {
        templateConfig: tw.templateConfig,
        userId,
        leadRow: { createdAt: testLeadTimestamp },
        db,
        connectionId: tw.connectionId ?? null,
      },
      { ...testLead, extraFields: {} },
    );
  }

  // Legacy custom/sotuvchi/100k destination → legacyTemplateAdapter.
  const adapter = getAdapter("legacy-template");
  if (!adapter) throw new Error("Adapter not found: legacy-template");
  return adapter.send(
    {
      templateType: tw.templateType,
      templateConfig: tw.templateConfig,
      variableFields,
      url: tw.url,
    },
    testLead,
  );
}

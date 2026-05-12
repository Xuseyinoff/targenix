import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  getDb,
} from "../db";
import { inArray, asc } from "drizzle-orm";
import { injectVariables } from "../services/affiliateService";
import { sendLeadTelegramNotification } from "../services/leadService";
import { sendTelegramRawMessage } from "../services/telegramService";
import { decrypt } from "../encryption";
import { destinations, integrationRoutes, type Destination } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { getAdapter } from "../integrations";
import { loadConnectionForDelivery } from "../integrations/dispatch";
import { resolveIntegrationRoutes } from "../services/integrationRoutes";
import type { DbClient } from "../db";
import type { FilterRule } from "../services/filterEngine";

export const integrationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const list = await getIntegrations(ctx.user.id);
    const db = await getDb();
    if (!db) return list;
    // Enrich LEAD_ROUTING integrations with targetWebsiteName from DB (using dedicated column)
    return Promise.all(
      list.map(async (integration) => {
        if (integration.type !== "LEAD_ROUTING") return integration;
        const cfg = integration.config as Record<string, unknown> | null;
        if (!integration.destinationId) return integration;
        const [tw] = await db
          .select({ id: destinations.id, name: destinations.name })
          .from(destinations)
          .where(and(
            eq(destinations.id, integration.destinationId),
            eq(destinations.userId, ctx.user.id),
          ))
          .limit(1);
        // Also enrich with ordered destinationIds from integration_routes
        const destRows = await db
          .select({ destinationId: integrationRoutes.destinationId })
          .from(integrationRoutes)
          .where(and(
            eq(integrationRoutes.integrationId, integration.id),
            eq(integrationRoutes.enabled, true),
          ))
          .orderBy(asc(integrationRoutes.position), asc(integrationRoutes.id));
        const destinationIds = destRows.map((r) => r.destinationId);
        return {
          ...integration,
          // `targetWebsiteName` has no dedicated column — falls back to JSON
          // for legacy rows where the destinations row was deleted.
          targetWebsiteName: tw?.name ?? (cfg?.targetWebsiteName as string | undefined) ?? null,
          destinationIds,
        };
      })
    );
  }),

  /**
   * Lead Routing wizard only. The standalone Affiliate integration type was
   * removed from both the UI and the delivery code path (audit 2026-05-12:
   * 0 production rows).
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
         * When provided, `integration_routes` is populated with the
         * full list instead of only the single id embedded in config.
         * The first entry also sets `integrations.destinationId` for
         * legacy compat (dispatch falls back to that column when the flag
         * is off).
         * Max 20 destinations per integration — reasonable upper bound that
         * prevents accidentally passing a large array.
         */
        destinationIds: z.array(z.number().int().positive()).max(20).optional(),
        /**
         * Top-level dedicated fields (preferred source for the corresponding
         * dedicated columns). Server prefers these and falls back to the
         * matching keys inside `config` for older callers that still embed
         * them in the JSON. Once all callers send top-level, the config
         * fallback can be removed.
         */
        pageId: z.string().max(128).optional(),
        formId: z.string().max(128).optional(),
        pageName: z.string().max(255).optional(),
        formName: z.string().max(255).optional(),
        facebookAccountId: z.number().int().positive().optional(),
        destinationId: z.number().int().positive().optional(),
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
          const { destinations } = await import("../../drizzle/schema");
          const owned = await db
            .select({ id: destinations.id })
            .from(destinations)
            .where(
              inArray(destinations.id, safeDestinationIds),
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
        pageId: input.pageId,
        formId: input.formId,
        pageName: input.pageName,
        formName: input.formName,
        facebookAccountId: input.facebookAccountId,
        destinationId: input.destinationId,
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
         * Stage B opt-in: when provided, `integration_routes` is
         * rewritten to this exact ordered list and the legacy
         * `integrations.destinationId` is set to the first id.
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
        /**
         * Top-level dedicated fields — see `create` above. Preferred over
         * the matching keys inside `config` when present.
         */
        pageId: z.string().max(128).optional(),
        formId: z.string().max(128).optional(),
        pageName: z.string().max(255).optional(),
        formName: z.string().max(255).optional(),
        facebookAccountId: z.number().int().positive().optional(),
        destinationId: z.number().int().positive().optional(),
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
          const { destinations } = await import("../../drizzle/schema");
          const ownedRows = await db
            .select({ id: destinations.id })
            .from(destinations)
            .where(inArray(destinations.id, safeDestinationIds));
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
      // the old behaviour where only the primary `destinationId` got
      // exercised and the other N-1 destinations stayed untested.
      const destinations = await resolveIntegrationRoutes(db, {
        id: integration.id,
        userId: integration.userId,
        destinationId: integration.destinationId,
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

  // ─── Filter CRUD ─────────────────────────────────────────────────────────────

  /**
   * Get all destination rows with their filterJson for one integration.
   * Used by the FilterBuilder UI to load current rules.
   */
  getDestinationFilters: protectedProcedure
    .input(z.object({ integrationId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      const list = await getIntegrations(ctx.user.id);
      if (!list.find((i) => i.id === input.integrationId)) return [];

      const rows = await db
        .select({
          mappingId: integrationRoutes.id,
          destinationId: integrationRoutes.destinationId,
          filterJson: integrationRoutes.filterJson,
          position: integrationRoutes.position,
          enabled: integrationRoutes.enabled,
        })
        .from(integrationRoutes)
        .where(eq(integrationRoutes.integrationId, input.integrationId))
        .orderBy(asc(integrationRoutes.position), asc(integrationRoutes.id));

      return rows.map((r) => ({
        ...r,
        filterJson: (r.filterJson ?? null) as FilterRule | null,
      }));
    }),

  /**
   * Save a FilterRule for a specific destination mapping row.
   * Ownership is verified via the parent integration.
   * Pass filter: null to clear the rule.
   */
  setDestinationFilter: protectedProcedure
    .input(z.object({
      integrationId:  z.number(),
      destinationId: z.number(),
      filter: z.object({
        enabled:    z.boolean(),
        logic:      z.enum(["AND", "OR"]),
        conditions: z.array(z.object({
          field:    z.string().min(1).max(128),
          operator: z.enum(["eq","neq","contains","not_contains","starts_with","ends_with","gt","gte","lt","lte","exists","not_exists","in","not_in"]),
          value:    z.string().max(500),
        })).max(20),
      }).nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      // Ownership guard: integration must belong to this user.
      const list = await getIntegrations(ctx.user.id);
      if (!list.find((i) => i.id === input.integrationId)) {
        throw new Error("Integration not found");
      }

      await db
        .update(integrationRoutes)
        .set({ filterJson: input.filter })
        .where(and(
          eq(integrationRoutes.integrationId, input.integrationId),
          eq(integrationRoutes.destinationId, input.destinationId),
        ));

      return { ok: true };
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
  tw: Destination;
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
    // Mirror the production dispatch path: when the destination is linked to a
    // connection, eagerly load it so `resolveSecretsForDelivery` can read
    // `credentialsJson.secretsEncrypted` instead of throwing CONNECTION_REQUIRED.
    const adapter = getAdapter("dynamic-template");
    if (!adapter) throw new Error("Adapter not found: dynamic-template");
    const connection =
      tw.connectionId != null
        ? await loadConnectionForDelivery(db, tw.connectionId, userId)
        : null;
    return adapter.send(
      { db, targetWebsite: tw, variableFields, connection, userId },
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

  // Manifest-driven destinations (http-api-key / http-oauth2) for rows that
  // have no templateId — e.g. hubspot OAuth rows where appKey alone steers
  // delivery. Route by appKey to mirror resolveAdapterKey().
  const apiKeyApps = new Set([
    "eskiz-sms",
    "playmobile-sms",
    "openai",
    "crm-generic",
    "webhook-json",
    "bitrix24",
    "amocrm",
  ]);
  const oauth2Apps = new Set(["hubspot", "kommo", "pipedrive"]);
  if (tw.appKey && apiKeyApps.has(tw.appKey)) {
    const adapter = getAdapter("http-api-key");
    if (!adapter) throw new Error("Adapter not found: http-api-key");
    return adapter.send(
      {
        appKey: tw.appKey,
        templateConfig: tw.templateConfig,
        leadRow: { createdAt: testLeadTimestamp },
        db,
        userId,
        connectionId: tw.connectionId ?? null,
      },
      testLead,
    );
  }
  if (tw.appKey && oauth2Apps.has(tw.appKey)) {
    const adapter = getAdapter("http-oauth2");
    if (!adapter) throw new Error("Adapter not found: http-oauth2");
    return adapter.send(
      {
        appKey: tw.appKey,
        templateConfig: tw.templateConfig,
        leadRow: { createdAt: testLeadTimestamp },
        db,
        userId,
        connectionId: tw.connectionId ?? null,
      },
      testLead,
    );
  }

  return {
    success: false,
    error:
      "Destination has no template and an unsupported appKey — cannot dispatch a test lead.",
  };
}

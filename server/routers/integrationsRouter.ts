import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getIntegrations,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  getDb,
  DuplicateIntegrationError,
} from "../db";
import { inArray, asc } from "drizzle-orm";
import { injectVariables } from "../services/affiliateService";
import { sendLeadTelegramNotification } from "../services/leadService";
import { sendTelegramRawMessage } from "../services/telegramService";
import { decrypt } from "../encryption";
import { destinations, integrationRoutes, integrations, type Destination } from "../../drizzle/schema";
import { eq, and, isNull } from "drizzle-orm";
import { ownedBy } from "../lib/assertUserOwns";
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

    // Enrich LEAD_ROUTING integrations with destination name + ordered
    // route ids. Previously this ran 2 queries PER integration (N+1):
    // ~101 round-trips for a 50-integration user. Now it's exactly 2
    // batched queries regardless of integration count.
    const leadRouting = list.filter((i) => i.type === "LEAD_ROUTING" && i.destinationId);
    if (leadRouting.length === 0) return list;

    // Batch 1 — destination names for the dedicated destinationId column.
    const destIds = Array.from(
      new Set(
        leadRouting
          .map((i) => i.destinationId)
          .filter((id): id is number => id != null),
      ),
    );
    const destNameById = new Map<number, string>();
    if (destIds.length > 0) {
      const destRows = await db
        .select({ id: destinations.id, name: destinations.name })
        .from(destinations)
        .where(and(
          inArray(destinations.id, destIds),
          eq(destinations.userId, ctx.user.id),
        ));
      for (const d of destRows) destNameById.set(d.id, d.name);
    }

    // Batch 2 — ordered route destinationIds, grouped by integrationId.
    // One query + in-memory group-by replaces N per-integration SELECTs.
    const integrationIds = leadRouting.map((i) => i.id);
    const routesByIntegration = new Map<number, number[]>();
    const routeRows = await db
      .select({
        integrationId: integrationRoutes.integrationId,
        destinationId: integrationRoutes.destinationId,
      })
      .from(integrationRoutes)
      .where(and(
        inArray(integrationRoutes.integrationId, integrationIds),
        eq(integrationRoutes.enabled, true),
      ))
      .orderBy(asc(integrationRoutes.position), asc(integrationRoutes.id));
    for (const r of routeRows) {
      const arr = routesByIntegration.get(r.integrationId) ?? [];
      arr.push(r.destinationId);
      routesByIntegration.set(r.integrationId, arr);
    }

    return list.map((integration) => {
      // Preserve original behaviour exactly: only LEAD_ROUTING rows that
      // have a dedicated destinationId get enriched; everything else is
      // returned bare.
      if (integration.type !== "LEAD_ROUTING" || !integration.destinationId) {
        return integration;
      }
      const cfg = integration.config as Record<string, unknown> | null;
      return {
        ...integration,
        // `targetWebsiteName` has no dedicated column — falls back to JSON
        // for legacy rows where the destinations row was deleted.
        targetWebsiteName:
          destNameById.get(integration.destinationId) ??
          (cfg?.targetWebsiteName as string | undefined) ??
          null,
        destinationIds: routesByIntegration.get(integration.id) ?? [],
      };
    });
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
      // Abuse guard: a real user wires up a handful of integrations per
      // session — 30/min is generous while blocking bulk-insert scripts.
      checkUserRateLimit(ctx.user.id, "integrationCreate", {
        max: 30,
        windowMs: 60_000,
        message: "Too many integrations created. Max 30 per minute.",
      });

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

      try {
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
      } catch (err) {
        if (err instanceof DuplicateIntegrationError) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              `This form is already routed to that destination. ` +
              `Edit the existing integration "${err.existingName}" (id=${err.existingId}) instead.`,
            cause: err,
          });
        }
        throw err;
      }
      return { success: true };
    }),

  /**
   * Clone an existing integration as a DRAFT template for the create wizard
   * (PR 3/3 — Yuboraman parity).
   *
   * Pure read — does NOT insert a row. Returns the source's policy fields
   * (FB account, destinations, telegram chat, per-routing variables, name
   * with " (copy)" suffix) so the wizard can pre-fill the create form. The
   * user MUST pick a new page+form before submitting, so the new integration
   * inherits PR 1's duplicate-prevention (CONFLICT if they accidentally
   * re-route to the same form-destination pair).
   *
   * Excluded from the draft: id, userId, createdAt, deletedAt, pageId/Name,
   * formId/Name, FROM_LEAD field mappings (depend on the new form's fields),
   * and customMappings (same).
   *
   * Tenant scope: enforced via `ownedBy(integrations, sourceId, userId)` +
   * `isNull(deletedAt)` in the WHERE clause. Throws NOT_FOUND for non-owned
   * or non-existent sources — error message intentionally generic, so it
   * does not leak whether the row belongs to another tenant.
   */
  clone: protectedProcedure
    .input(z.object({ sourceId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      }

      const [source] = await db
        .select()
        .from(integrations)
        .where(and(ownedBy(integrations, input.sourceId, ctx.user.id), isNull(integrations.deletedAt)))
        .limit(1);

      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Integration not found or access denied",
        });
      }

      // Load fan-out destinations (multi-destination support). Order matters —
      // the wizard renders them in this order.
      const routeRows = await db
        .select({ destinationId: integrationRoutes.destinationId })
        .from(integrationRoutes)
        .where(
          and(
            eq(integrationRoutes.integrationId, source.id),
            eq(integrationRoutes.enabled, true),
          ),
        )
        .orderBy(asc(integrationRoutes.position), asc(integrationRoutes.id));
      const fanoutDestinationIds = routeRows.map((r) => r.destinationId);

      const cfg = (source.config as Record<string, unknown> | null) ?? {};

      return {
        template: {
          type: "LEAD_ROUTING" as const,
          name: `${source.name} (copy)`,
          facebookAccountId: source.facebookAccountId,
          destinationId: source.destinationId,
          /**
           * The wizard prefers `destinationIds` (the fan-out list) when set;
           * falls back to the single `destinationId` for legacy rows that
           * predate integration_routes. Match the wizard's existing
           * edit-mode hydration so the create path can reuse the same code
           * path.
           */
          destinationIds: fanoutDestinationIds.length > 0
            ? fanoutDestinationIds
            : source.destinationId
              ? [source.destinationId]
              : [],
          telegramChatId: source.telegramChatId,
          /**
           * Per-routing user-provided variables (e.g. {offer_id: "110566",
           * stream: "abc"}). These are template-shape values the user picks
           * once per integration — naturally carry over to the clone.
           */
          variableFields: (cfg.variableFields as Record<string, string> | undefined) ?? {},
          /**
           * Display-only labels for the destination. The wizard re-derives
           * these from the destination row on hydration; included here for
           * older callers that might short-circuit the lookup.
           */
          targetWebsiteName: (cfg.targetWebsiteName as string | null | undefined) ?? null,
          targetTemplateType: (cfg.targetTemplateType as string | null | undefined) ?? null,
        },
        clonedFrom: source.id,
        clonedFromName: source.name,
      };
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
      // Updates (toggle active, rename, re-map) run more often than creates.
      checkUserRateLimit(ctx.user.id, "integrationUpdate", {
        max: 60,
        windowMs: 60_000,
        message: "Too many integration updates. Max 60 per minute.",
      });

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

  if (tw.appKey === "telegram") {
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

  if (tw.appKey === "google-sheets") {
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
  // delivery. Route by appKey to mirror resolveAdapterKey(). The retired
  // webhook-json / crm-generic keys are intentionally absent (Phase 4).
  const apiKeyApps = new Set([
    "eskiz-sms",
    "playmobile-sms",
    "openai",
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

  // Universal HTTP — appKey="http-request" (also catches the legacy
  // "plain-url" sentinel routed through this adapter, see resolveAdapterKey).
  if (tw.appKey === "http-request" || tw.appKey === "plain-url") {
    const adapter = getAdapter("http-request");
    if (!adapter) throw new Error("Adapter not found: http-request");
    const tplCfg = (tw.templateConfig ?? {}) as Record<string, unknown>;
    return adapter.send(
      { ...tplCfg, leadRow: { createdAt: testLeadTimestamp } },
      testLead,
    );
  }

  return {
    success: false,
    error:
      "Destination has no template and an unsupported appKey — cannot dispatch a test lead.",
  };
}

import { and, desc, eq, isNotNull, lt, lte } from "drizzle-orm";
import { facebookConnections, facebookAccounts, facebookForms, integrationDestinations, leads, orders, integrations, users, targetWebsites } from "../../drizzle/schema";
import { getDb } from "../db";
import { decrypt } from "../encryption";
import { fetchLeadData, extractLeadFields } from "./facebookService";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";
import { affiliateAdapter } from "../integrations/adapters/affiliateAdapter";
import { dispatchDelivery } from "../integrations/dispatch";
import { resolveIntegrationDestinations, type ResolvedDestination } from "./integrationDestinations";
import { isMultiDestinationsEnabled } from "./featureFlags";
import { formatLeadMessage } from "./telegramFormatter";
import { log, logEvent } from "./appLogger";
import { aggregateLeadDeliveryFromOrderStatuses } from "../lib/leadPipeline";
import {
  ORDER_MAX_DELIVERY_ATTEMPTS,
  computeNextRetryAt,
  type DeliveryErrorType,
} from "../lib/orderRetryPolicy";
import { incFailedOrders } from "../monitoring/metrics";

// ─── Field extraction helpers ─────────────────────────────────────────────────

const CORE_FIELD_NAMES = new Set(["full_name", "phone_number", "FULL_NAME", "PHONE_NUMBER"]);

/**
 * Build extraFields JSON from field_data — all entries except name + phone.
 */
function buildExtraFields(
  fieldData: Array<{ name: string; values: string[] }>
): Record<string, string> | null {
  const extra: Record<string, string> = {};
  for (const f of fieldData) {
    if (CORE_FIELD_NAMES.has(f.name)) continue;
    const val = f.values?.[0];
    if (val !== undefined && val !== null && val !== "") extra[f.name] = val;
  }
  return Object.keys(extra).length > 0 ? extra : null;
}

/**
 * Save an incoming lead to the database with PENDING status.
 * Called from the webhook handler — must be fast.
 * Writes pageName/formName immediately from facebook_forms cache.
 */
export async function saveIncomingLead(params: {
  userId: number;
  pageId: string;
  formId: string;
  leadgenId: string;
  rawData: unknown;
}): Promise<number | null> {
  const db = await getDb();
  if (!db) {
    console.error("[LeadService] DB not available");
    return null;
  }

  try {
    // Extract platform from rawData (Graph API returns 'fb' or 'ig')
    const rawDataObj = params.rawData as Record<string, unknown> | null;
    const platform = (rawDataObj?.platform === "ig" ? "ig" : "fb") as "fb" | "ig";

    // Lookup pageName/formName from facebook_forms (tenant-safe)
    const [formRow] = await db
      .select({ pageName: facebookForms.pageName, formName: facebookForms.formName })
      .from(facebookForms)
      .where(
        and(
          eq(facebookForms.userId, params.userId),
          eq(facebookForms.pageId, params.pageId),
          eq(facebookForms.formId, params.formId),
        )
      )
      .limit(1);

    // Upsert to avoid duplicate processing
    await db
      .insert(leads)
      .values({
        userId:   params.userId,
        pageId:   params.pageId,
        formId:   params.formId,
        leadgenId: params.leadgenId,
        rawData:  params.rawData,
        platform,
        pageName: formRow?.pageName ?? null,
        formName: formRow?.formName ?? null,
        dataStatus:     "PENDING",
        deliveryStatus: "PENDING",
      })
      .onDuplicateKeyUpdate({
        set: {
          rawData:  params.rawData,
          platform,
          pageName: formRow?.pageName ?? null,
          formName: formRow?.formName ?? null,
        },
      });

    // Must filter by BOTH leadgenId AND userId — composite unique index
    const [saved] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.leadgenId, params.leadgenId), eq(leads.userId, params.userId)))
      .limit(1);

    await log.info("LEAD", `Lead saved — id=${saved?.id} leadgenId=${params.leadgenId}`, { leadgenId: params.leadgenId, pageId: params.pageId, formId: params.formId }, saved?.id ?? null, params.pageId, params.userId, "lead_saved", "facebook");
    return saved?.id ?? null;
  } catch (err) {
    await log.error("LEAD", `Failed to save lead — leadgenId=${params.leadgenId}`, { error: String(err), stack: err instanceof Error ? err.stack : undefined }, null, params.pageId, params.userId, "error", "facebook");
    return null;
  }
}

/**
 * Resolve an access token for a page.
 * Priority: LEAD_ROUTING integration config → facebookAccounts → facebookConnections (legacy)
 */
async function resolvePageAccessToken(
  pageId: string,
  formId: string,
  userId: number
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  // 1. Try to find a LEAD_ROUTING integration that matches this page+form
  //    Use dedicated columns (indexed) with config JSON as fallback for safety
  const allIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.isActive, true),
      eq(integrations.pageId, pageId), eq(integrations.formId, formId)));

  for (const integration of allIntegrations) {
    if (integration.type !== "LEAD_ROUTING") continue;
    const config = integration.config as Record<string, unknown>;
    // Use dedicated columns (indexed)
    const intPageId = integration.pageId ?? "";
    const intFormId = integration.formId ?? "";
    if (intPageId === pageId && intFormId === formId) {
      // Use the account token — MUST verify userId to prevent cross-user token access
      const accountId = (config.facebookAccountId ?? config.accountId) as number | undefined;
      if (accountId) {
        const [account] = await db
          .select()
          .from(facebookAccounts)
          .where(and(eq(facebookAccounts.id, accountId), eq(facebookAccounts.userId, userId)))
          .limit(1);
        if (account) {
          return decrypt(account.accessToken);
        }
      }
    }
  }

  // 2. facebookAccounts stores user-level tokens, not page-level tokens
  // Page tokens are obtained dynamically via the Graph API when needed

  // 3. Legacy fallback: facebookConnections — MUST include userId to prevent
  //    cross-user token access when multiple users share the same Facebook page.
  //    After migration 0035 one page can have multiple connections (one per FB account).
  //    Filter isActive=true and take the most recently created one to avoid stale tokens.
  const [connection] = await db
    .select()
    .from(facebookConnections)
    .where(and(
      eq(facebookConnections.userId, userId),
      eq(facebookConnections.pageId, pageId),
      eq(facebookConnections.isActive, true),
    ))
    .orderBy(desc(facebookConnections.createdAt))
    .limit(1);
  if (connection) {
    return decrypt(connection.accessToken);
  }

  return null;
}

/**
 * Extract field values from raw lead data using custom field mapping from LEAD_ROUTING config.
 * Falls back to the generic extractLeadFields if no mapping is configured.
 * Also resolves extraFields (user-defined key→formField or staticValue mappings).
 */
export function extractWithMappingForPoll(
  fieldData: Array<{ name: string; values: string[] }>,
  nameField?: string,
  phoneField?: string,
): { fullName: string | null; phone: string | null; email: string | null } {
  return extractWithMapping(fieldData, {}, nameField, phoneField);
}

/**
 * Convert an integration's `config` JSON into the trio of values every lead
 * extraction call needs: `nameField`, `phoneField`, and the list of extra
 * field mappings.
 *
 * Two persisted shapes coexist today — this helper hides the dual-read from
 * callers so the logic only lives in one place and can never drift between
 * the realtime webhook path (`processLead`) and the Graph-polling path
 * (`leadsRouter.pollFromForm`).
 *
 *   1. New (IntegrationWizardV2) — `config.fieldMappings: Array<{ from, to,
 *      staticValue? }>`. Rows with `to === "name"` / `"phone"` become the
 *      core field pointers; every other row becomes an `extraFields` entry
 *      (dest key → source FB form field or literal static value).
 *
 *   2. Legacy (classic routing wizard) — flat `config.nameField`,
 *      `config.phoneField`, and `config.extraFields` in the final shape
 *      `extractWithMapping` already understands.
 *
 * When BOTH shapes are present (V2 wizard writes legacy duplicates for
 * compat) the new `fieldMappings` wins, matching the precedence
 * `processLead` already uses — so this refactor is behaviour-preserving.
 */
export function resolveLeadMappingFromConfig(
  config: Record<string, unknown> | null | undefined,
): {
  nameField: string | undefined;
  phoneField: string | undefined;
  extraFields:
    | Array<{ destKey: string; sourceField?: string; staticValue?: string }>
    | undefined;
} {
  const cfg = (config ?? {}) as Record<string, unknown>;

  const fieldMappings = cfg.fieldMappings as
    | Array<{ from: string | null; to: string; staticValue?: string }>
    | undefined;

  if (fieldMappings && fieldMappings.length > 0) {
    const nameEntry = fieldMappings.find((m) => m.to === "name" && m.from);
    const phoneEntry = fieldMappings.find(
      (m) => m.to === "phone" && m.from,
    );
    const extraFields = fieldMappings
      .filter((m) => m.to !== "name" && m.to !== "phone" && m.to.trim())
      .map((m) => ({
        destKey: m.to,
        sourceField: m.from ?? undefined,
        staticValue: m.staticValue,
      }));
    return {
      nameField: nameEntry?.from ?? undefined,
      phoneField: phoneEntry?.from ?? undefined,
      extraFields,
    };
  }

  return {
    nameField: cfg.nameField as string | undefined,
    phoneField: cfg.phoneField as string | undefined,
    extraFields: cfg.extraFields as
      | Array<{ destKey: string; sourceField?: string; staticValue?: string }>
      | undefined,
  };
}

function extractWithMapping(
  fieldData: Array<{ name: string; values: string[] }>,
  leadMeta: {
    ad_id?: string; ad_name?: string;
    adset_id?: string; adset_name?: string;
    campaign_id?: string; campaign_name?: string;
    form_id?: string; leadgen_id?: string;
  },
  nameField?: string,
  phoneField?: string,
  extraFields?: Array<{ destKey: string; sourceField?: string; staticValue?: string }>,
): {
  fullName: string | null;
  phone: string | null;
  email: string | null;
  extra: Record<string, string>;
} {
  const getFormField = (key: string): string | null => {
    const f = fieldData.find((d) => d.name === key);
    return f?.values?.[0] ?? null;
  };

  // Facebook metadata resolver
  const META_MAP: Record<string, string | undefined> = {
    ad_id:         leadMeta.ad_id,
    ad_name:       leadMeta.ad_name,
    adset_id:      leadMeta.adset_id,
    adset_name:    leadMeta.adset_name,
    campaign_id:   leadMeta.campaign_id,
    campaign_name: leadMeta.campaign_name,
    form_id:       leadMeta.form_id,
    lead_id:       leadMeta.leadgen_id,
  };

  const resolveSource = (sourceField: string): string | null =>
    META_MAP[sourceField] !== undefined
      ? (META_MAP[sourceField] ?? null)
      : getFormField(sourceField);

  const base = nameField || phoneField
    ? {
        fullName: nameField ? getFormField(nameField) : null,
        phone:    phoneField ? getFormField(phoneField) : null,
        email:    getFormField("email"),
      }
    : extractLeadFields(fieldData);

  // Resolve user-defined extra field mappings
  const extra: Record<string, string> = {};
  for (const ef of extraFields ?? []) {
    if (!ef.destKey) continue;
    if (ef.staticValue !== undefined && ef.staticValue !== "") {
      extra[ef.destKey] = ef.staticValue;
    } else if (ef.sourceField) {
      const val = resolveSource(ef.sourceField);
      if (val !== null) extra[ef.destKey] = val;
    }
  }

  return { ...base, extra };
}

/**
 * Send a universal Telegram notification about a lead to the appropriate chat.
 * Priority: integration.telegramChatId → user.telegramChatId (personal).
 * Uses the system bot (TELEGRAM_BOT_TOKEN) for both.
 */
export async function sendLeadTelegramNotification(params: {
  /** Must include userId so we only use telegramChatId when the row belongs to this tenant (SaaS). */
  integration: { userId: number; telegramChatId?: string | null; name: string; type: string };
  userId: number;
  lead: {
    fullName: string | null;
    phone: string | null;
    email: string | null;
    pageId: string;
    formId: string;
    leadgenId: string;
  };
  result: { success: boolean; responseData?: unknown; error?: string; durationMs?: number };
  isTest?: boolean;
  isAdmin?: boolean;
  /** Timed order auto-retry vs initial webhook delivery */
  deliverySource?: "initial" | "auto_retry";
  /** 1-based attempt / max; only used when deliverySource is auto_retry */
  deliveryAttempt?: { current: number; max: number };
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const deliverySource = params.deliverySource ?? "initial";
  const isAutoRetry = deliverySource === "auto_retry";

  // DELIVERY rule (SPEC): leads must go ONLY to a delivery chat assigned to the integration.
  // System chat (users.telegramChatId) is reserved for alerts/errors/stats — never lead deliveries.
  let chatId: string | null = null;
  const integrationOwned = params.integration.userId === params.userId;
  if (!integrationOwned && params.integration.telegramChatId?.trim()) {
    await log.warn(
      "TELEGRAM",
      "Ignored integration.telegramChatId — integration.userId does not match notification userId",
      { integrationUserId: params.integration.userId, userId: params.userId },
      null,
      params.lead.pageId,
      params.userId,
      "telegram_chat_guard",
      "system",
    );
  }
  if (integrationOwned && params.integration.telegramChatId?.trim()) {
    chatId = params.integration.telegramChatId.trim();
  }
  if (!chatId) return; // No delivery chat assigned for this integration

  // Resolve page name and account name for richer context
  let pageName: string | null = null;
  let accountName: string | null = null;
  let formName: string | null = null;
  let targetWebsiteName: string | null = null;

  try {
    // MUST filter by userId — without it, another user's page name would leak
    // into this user's Telegram notification.
    const [conn] = await db
      .select({ pageName: facebookConnections.pageName })
      .from(facebookConnections)
      .where(and(eq(facebookConnections.pageId, params.lead.pageId), eq(facebookConnections.userId, params.userId)))
      .limit(1);
    pageName = conn?.pageName ?? null;

    // Look up account name, formName, and targetWebsiteName from LEAD_ROUTING config
    const allIntegrations = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.userId, params.userId), eq(integrations.isActive, true),
        eq(integrations.pageId, params.lead.pageId), eq(integrations.formId, params.lead.formId)));
    for (const intg of allIntegrations) {
      if (intg.type !== "LEAD_ROUTING") continue;
      const cfg = intg.config as Record<string, unknown>;
      const intPageId = intg.pageId ?? "";
      const intFormId = intg.formId ?? "";
      if (intPageId === params.lead.pageId && intFormId === params.lead.formId) {
        formName = intg.formName ?? (cfg.formName as string | undefined) ?? null;
        // config uses 'facebookAccountId' (not 'accountId')
        const accountId = (cfg.facebookAccountId ?? cfg.accountId) as number | undefined;
        if (accountId) {
          const [acct] = await db
            .select({ fbUserName: facebookAccounts.fbUserName })
            .from(facebookAccounts)
            .where(eq(facebookAccounts.id, accountId))
            .limit(1);
          accountName = acct?.fbUserName ?? null;
        }
        // Resolve targetWebsiteName from dedicated column (indexed)
        const twId = intg.targetWebsiteId ?? (cfg.targetWebsiteId ? Number(cfg.targetWebsiteId) : null);
        if (twId) {
          const [tw] = await db
            .select({ name: targetWebsites.name })
            .from(targetWebsites)
            .where(eq(targetWebsites.id, twId))
            .limit(1);
          targetWebsiteName = tw?.name ?? null;
        }
        break;
      }
    }
  } catch {
    // Non-critical — proceed without enriched context
  }

  const html = formatLeadMessage({
    lead: {
      fullName: params.lead.fullName,
      phone: params.lead.phone,
      accountName,
      pageName,
      formName,
    },
    routing: {
      integrationName: params.integration.name,
      targetWebsiteName,
      success: params.result.success,
      responseData: params.result.responseData,
      error: params.result.error,
      durationMs: params.result.durationMs,
    },
    isTest: params.isTest ?? false,
    isAdmin: params.isAdmin ?? false,
    isAutoRetry,
    deliveryAttempt: isAutoRetry ? params.deliveryAttempt : undefined,
  });

  await sendTelegramMessage(chatId, html, "HTML");
}

type DbClient = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type IntegrationDeliveryResult = {
  success: boolean;
  responseData?: unknown;
  error?: string;
  durationMs?: number;
  errorType?: DeliveryErrorType;
};

async function persistOrderDeliveryAttemptResult(
  db: DbClient,
  params: { orderId: number; prevAttempts: number; result: IntegrationDeliveryResult },
): Promise<boolean> {
  const { orderId, prevAttempts, result } = params;
  const now = new Date();
  const newAttempts = prevAttempts + 1;
  const nextRetry = computeNextRetryAt({
    now,
    newAttempts,
    maxAttempts: ORDER_MAX_DELIVERY_ATTEMPTS,
    success: result.success,
    errorType: result.errorType,
  });

  let merged: Record<string, unknown>;
  if (
    result.responseData != null &&
    typeof result.responseData === "object" &&
    !Array.isArray(result.responseData)
  ) {
    merged = { ...(result.responseData as Record<string, unknown>) };
  } else if (result.responseData === undefined) {
    merged = result.error !== undefined ? { error: result.error } : {};
  } else {
    merged = { body: result.responseData };
  }
  if (result.error !== undefined) merged.error = result.error;
  if (result.errorType !== undefined) merged.errorType = result.errorType;
  merged.attempts = newAttempts;

  const common = {
    attempts: newAttempts,
    lastAttemptAt: now,
    responseData: merged,
  };

  const setPayload = result.success
    ? { ...common, status: "SENT" as const, nextRetryAt: null as null }
    : { ...common, status: "FAILED" as const, nextRetryAt: nextRetry };

  const up = await db
    .update(orders)
    .set(setPayload)
    .where(and(eq(orders.id, orderId), eq(orders.attempts, prevAttempts)));

  const raw = up as unknown;
  const n =
    Array.isArray(raw) && raw[0] && typeof (raw[0] as { affectedRows?: number }).affectedRows === "number"
      ? (raw[0] as { affectedRows: number }).affectedRows
      : typeof (raw as { affectedRows?: number })?.affectedRows === "number"
        ? (raw as { affectedRows: number }).affectedRows
        : 0;
  if (n === 1 && !result.success) {
    incFailedOrders(1);
  }
  return n === 1;
}

/**
 * Send one order to its integration (Graph already done — routing only).
 * Shared by processLead and the hourly order retry job.
 *
 * `preResolvedDestination` — when provided (including null), the LEAD_ROUTING
 * branch uses it directly and skips the `resolveIntegrationDestinations` call.
 * Pass `undefined` (or omit) to fall back to the legacy inline resolution.
 * This avoids a double-query when the caller (fan-out loop) already resolved
 * the destination list.
 */
async function runOrderIntegrationSend(params: {
  db: DbClient;
  integration: typeof integrations.$inferSelect;
  lead: typeof leads.$inferSelect;
  leadPayload: {
    leadgenId: string;
    fullName: string | null;
    phone: string | null;
    email: string | null;
    pageId: string;
    formId: string;
    extraFields: Record<string, string>;
  };
  userId: number;
  isAdmin?: boolean;
  /** Hourly auto-retry uses auto_retry so Telegram shows [RETRY]; webhook/processLead uses initial */
  deliverySource?: "initial" | "auto_retry";
  /** Set for auto_retry: this delivery is attempt `current` of `max` */
  deliveryAttempt?: { current: number; max: number };
  /**
   * Pre-resolved destination to dispatch to.
   * - `undefined` (default): let the LEAD_ROUTING branch call the resolver
   *   internally (legacy single-destination path).
   * - `ResolvedDestination`: use this destination, skip the resolver call.
   * - `null`: explicitly "no destination configured" — dispatch with tw=null
   *   (triggers plain-url fallback or validation error).
   */
  preResolvedDestination?: ResolvedDestination | null;
}): Promise<IntegrationDeliveryResult> {
  const { db, integration, lead, leadPayload, userId, isAdmin } = params;
  const deliverySource = params.deliverySource ?? "initial";
  let result: IntegrationDeliveryResult;

  if (integration.type === "AFFILIATE") {
    const _t0Affiliate = Date.now();
    result = await affiliateAdapter.send(integration.config, leadPayload);
    result.durationMs = Date.now() - _t0Affiliate;
    await log[result.success ? "info" : "warn"](
      "AFFILIATE",
      result.success ? `Affiliate order sent for leadId=${lead.id}` : `Affiliate order failed for leadId=${lead.id}`,
      { integrationId: integration.id, error: result.error },
      lead.id,
      leadPayload.pageId,
      userId,
      "sent_to_affiliate",
      "facebook",
      result.durationMs,
    );
    await sendLeadTelegramNotification({
      integration: {
        userId: integration.userId,
        telegramChatId: integration.telegramChatId,
        name: integration.name,
        type: integration.type,
      },
      userId,
      lead: {
        fullName: leadPayload.fullName,
        phone: leadPayload.phone,
        email: leadPayload.email,
        pageId: leadPayload.pageId,
        formId: leadPayload.formId,
        leadgenId: leadPayload.leadgenId,
      },
      result,
      isAdmin: isAdmin ?? false,
      deliverySource,
      deliveryAttempt: deliverySource === "auto_retry" ? params.deliveryAttempt : undefined,
    });
  } else if (integration.type === "LEAD_ROUTING") {
    const config = integration.config as Record<string, unknown>;
    const _t0Routing = Date.now();
    let targetUrlUsed: string | undefined;
    let destinationTelegramChatId: string | null = null;

    // Resolve the destination to dispatch to.
    //
    // Fast path: the caller (fan-out loop in processLead, or the retry path
    // in retryFailedOrderDelivery) already fetched the destination and passes
    // it in as `preResolvedDestination`. We use it directly — avoids a
    // redundant DB round-trip.
    //
    // Legacy path: `preResolvedDestination` is `undefined` — we call the
    // resolver here so existing callers that don't pass it keep working.
    let primary: ResolvedDestination | null;
    if (params.preResolvedDestination !== undefined) {
      primary = params.preResolvedDestination;
    } else {
      const resolved = await resolveIntegrationDestinations(db, {
        id: integration.id,
        userId: integration.userId,
        targetWebsiteId: integration.targetWebsiteId ?? null,
        config: integration.config,
      });
      primary = resolved[0] ?? null;
    }

    const tw = primary?.targetWebsite ?? null;
    // Preserve the legacy semantics exactly: whitespace-only trims to null,
    // missing mapping is null — both branches fall through to the user's
    // default Telegram chat in sendLeadTelegramNotification() below.
    destinationTelegramChatId = tw?.telegramChatId?.trim() || null;

    // The legacy path used to flag "Target website owner mismatch" when the
    // column pointed to a target that belonged to someone else. The new
    // resolver already filters mismatches out (empty list + console warn),
    // so here we only need to distinguish "no destination configured"
    // from "one was configured but had a mismatch".
    const hadConfiguredTarget =
      integration.targetWebsiteId != null ||
      (integration.config as Record<string, unknown> | null)?.targetWebsiteId != null;
    if (!tw && hadConfiguredTarget) {
      result = { success: false, error: "Target website owner mismatch", errorType: "validation" };
    } else {
      const variableFields = (config.variableFields as Record<string, string> | undefined) ?? {};
      const dispatched = await dispatchDelivery(
        {
          db,
          userId,
          integrationType: "LEAD_ROUTING",
          integrationConfig: config,
          targetWebsite: tw,
          leadRow: lead,
          variableFields,
        },
        leadPayload,
      );
      targetUrlUsed = dispatched.targetUrlUsed;
      result = {
        success: dispatched.success,
        responseData: dispatched.responseData,
        error: dispatched.error,
        errorType: dispatched.errorType,
      };
    }
    result.durationMs = Date.now() - _t0Routing;
    await log[result.success ? "info" : "warn"](
      "ORDER",
      result.success ? `Lead routed to target website for leadId=${lead.id}` : `Lead routing failed for leadId=${lead.id}`,
      {
        integrationId: integration.id,
        targetUrl: targetUrlUsed ?? ((config.targetUrl as string | undefined) ?? undefined),
        error: result.error ?? null,
        responseData: (result as { responseData?: unknown }).responseData,
      },
      lead.id,
      leadPayload.pageId,
      userId,
      "sent_to_target_website",
      "facebook",
      result.durationMs,
    );
    await sendLeadTelegramNotification({
      integration: {
        userId: integration.userId,
        // Delivery chat is mapped on destination (target website), not on integration.
        telegramChatId: destinationTelegramChatId,
        name: integration.name,
        type: integration.type,
      },
      userId,
      lead: {
        fullName: leadPayload.fullName,
        phone: leadPayload.phone,
        email: leadPayload.email,
        pageId: leadPayload.pageId,
        formId: leadPayload.formId,
        leadgenId: leadPayload.leadgenId,
      },
      result,
      isAdmin: isAdmin ?? false,
      deliverySource,
      deliveryAttempt: deliverySource === "auto_retry" ? params.deliveryAttempt : undefined,
    });
  } else {
    result = {
      success: false,
      error: `Unsupported integration type: ${integration.type}`,
      errorType: "validation",
    };
  }

  return result;
}

/**
 * Handle the full lifecycle for a single (integration, destination) pair:
 *   1. Look up the existing order by `(leadId, integrationId, destinationId)`.
 *   2. Skip if already SENT, exhausted, or not yet due for retry.
 *   3. Create the order row if it doesn't exist (with destinationId so the
 *      unique key `uq_orders_lead_int_dest` scopes it correctly).
 *   4. Dispatch via `runOrderIntegrationSend`.
 *   5. Persist the attempt result.
 *
 * `destinationId` is 0 for AFFILIATE integrations and for the legacy
 * single-destination LEAD_ROUTING path (flag off). It equals the
 * `integration_destinations.id` for the fan-out path (flag on, N > 1).
 *
 * `preResolvedDestination` is forwarded to `runOrderIntegrationSend` so the
 * dispatcher doesn't re-query the destination. Pass `undefined` for the
 * legacy path (resolver runs inside `runOrderIntegrationSend`).
 */
async function deliverOneDestination(params: {
  db: DbClient;
  integration: typeof integrations.$inferSelect;
  destinationId: number;
  preResolvedDestination?: ResolvedDestination | null;
  leadId: number;
  leadRow: typeof leads.$inferSelect;
  leadPayload: {
    leadgenId: string;
    fullName: string | null;
    phone: string | null;
    email: string | null;
    pageId: string;
    formId: string;
    extraFields: Record<string, string>;
  };
  userId: number;
  pageId: string;
  isAdmin?: boolean;
}): Promise<void> {
  const { db, integration, destinationId, leadId, leadRow, leadPayload, userId, pageId } = params;

  const [existingOrder] = await db
    .select({
      id: orders.id,
      status: orders.status,
      attempts: orders.attempts,
      nextRetryAt: orders.nextRetryAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.leadId, leadId),
        eq(orders.integrationId, integration.id),
        eq(orders.destinationId, destinationId),
      ),
    )
    .limit(1);

  if (existingOrder?.status === "SENT") return;
  if (existingOrder?.status === "FAILED") {
    if (existingOrder.attempts >= ORDER_MAX_DELIVERY_ATTEMPTS) return;
    if (existingOrder.nextRetryAt && existingOrder.nextRetryAt > new Date()) return;
  }

  let orderId: number;
  let prevAttempts: number;

  if (!existingOrder) {
    await db.insert(orders).values({
      leadId,
      userId,
      integrationId: integration.id,
      destinationId,
      status: "PENDING",
      attempts: 0,
    });
    const [row] = await db
      .select({ id: orders.id, attempts: orders.attempts })
      .from(orders)
      .where(
        and(
          eq(orders.leadId, leadId),
          eq(orders.integrationId, integration.id),
          eq(orders.destinationId, destinationId),
        ),
      )
      .limit(1);
    if (!row) return;
    orderId = row.id;
    prevAttempts = row.attempts;
  } else {
    orderId = existingOrder.id;
    prevAttempts = existingOrder.attempts;
  }

  const result = await runOrderIntegrationSend({
    db,
    integration,
    lead: leadRow,
    leadPayload,
    userId,
    isAdmin: params.isAdmin,
    preResolvedDestination: params.preResolvedDestination,
  });

  const persisted = await persistOrderDeliveryAttemptResult(db, { orderId, prevAttempts, result });
  if (!persisted) {
    await log.warn(
      "ORDER",
      `Order ${orderId} delivery result not persisted (concurrent update)`,
      { orderId, prevAttempts, destinationId },
      leadId,
      pageId,
      userId,
      "order_delivery_race",
      "facebook",
    );
  }
}

export async function recalculateLeadDeliveryStatus(leadId: number, userId?: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db.select({ status: orders.status }).from(orders).where(eq(orders.leadId, leadId));
  const deliveryStatus = aggregateLeadDeliveryFromOrderStatuses(
    rows.map((r) => r.status as "PENDING" | "SENT" | "FAILED"),
  );
  const whereClause = userId
    ? and(eq(leads.id, leadId), eq(leads.userId, userId))
    : eq(leads.id, leadId);
  await db.update(leads).set({ deliveryStatus }).where(whereClause);
}

/**
 * Full lead processing pipeline:
 * 1. Resolve page access token → Graph API enrichment (dataStatus)
 * 2. If enrichment fails → dataStatus ERROR, deliveryStatus PENDING, no routing
 * 3. Else → dataStatus ENRICHED, run integrations (deliveryStatus PROCESSING → aggregate)
 */
export async function processLead(params: {
  leadId: number;
  leadgenId: string;
  pageId: string;
  formId: string;
  userId: number;
  /** When true, Telegram message will show [ADMIN] badge */
  isAdmin?: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  let pageName: string | null = null;
  let formName: string | null = null;
  let resolvedPlatform: "fb" | "ig" | null = null;
  try {
    const [formRow] = await db
      .select({ pageName: facebookForms.pageName, formName: facebookForms.formName, platform: facebookForms.platform })
      .from(facebookForms)
      .where(
        and(
          eq(facebookForms.userId, params.userId),
          eq(facebookForms.pageId, params.pageId),
          eq(facebookForms.formId, params.formId),
        )
      )
      .limit(1);
    pageName = formRow?.pageName ?? null;
    formName = formRow?.formName ?? null;
    resolvedPlatform = (formRow?.platform as "fb" | "ig" | null) ?? null;
  } catch { /* non-critical */ }

  const accessToken = await resolvePageAccessToken(params.pageId, params.formId, params.userId);

  if (!accessToken) {
    await log.warn("LEAD", `No access token found — lead data cannot be fetched`, { pageId: params.pageId, formId: params.formId }, params.leadId, params.pageId, params.userId, "lead_enriched", "facebook");
    await db
      .update(leads)
      .set({
        dataStatus: "ERROR",
        deliveryStatus: "PENDING",
        dataError: "No Facebook page access token — connect a page or LEAD_ROUTING integration with a valid account.",
        pageName,
        formName,
      })
      .where(and(eq(leads.id, params.leadId), eq(leads.userId, params.userId)));
    return;
  }

  const leadData = await fetchLeadData(params.leadgenId, accessToken);
  if (!leadData) {
    await db
      .update(leads)
      .set({
        dataStatus: "ERROR",
        deliveryStatus: "PENDING",
        dataError: "Facebook Graph API returned no lead payload.",
        pageName,
        formName,
      })
      .where(and(eq(leads.id, params.leadId), eq(leads.userId, params.userId)));
    return;
  }

  const rawData: unknown = leadData;

  const allIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, params.userId), eq(integrations.isActive, true),
      eq(integrations.pageId, params.pageId), eq(integrations.formId, params.formId)));

  let nameField: string | undefined;
  let phoneField: string | undefined;
  let extraFields: Array<{ destKey: string; sourceField?: string; staticValue?: string }> | undefined;

  for (const integration of allIntegrations) {
    if (integration.type !== "LEAD_ROUTING") continue;
    const config = integration.config as Record<string, unknown>;
    const intPageId = integration.pageId ?? "";
    const intFormId = integration.formId ?? "";
    if (intPageId === params.pageId && intFormId === params.formId) {
      // Dual-shape read — new V2 `fieldMappings` takes precedence, legacy
      // `nameField` / `phoneField` / `extraFields` is the fallback. The
      // helper centralises this so `pollFromForm` (Graph poller) stays in
      // lock-step and can never drift from the webhook path.
      const resolved = resolveLeadMappingFromConfig(config);
      nameField = resolved.nameField;
      phoneField = resolved.phoneField;
      extraFields = resolved.extraFields;
      break;
    }
  }

  const leadMeta = {
    ad_id:         leadData.ad_id,
    ad_name:       leadData.ad_name,
    adset_id:      leadData.adset_id,
    adset_name:    leadData.adset_name,
    campaign_id:   leadData.campaign_id,
    campaign_name: leadData.campaign_name,
    form_id:       leadData.form_id,
    leadgen_id:    params.leadgenId,
  };

  const fields = extractWithMapping(leadData.field_data, leadMeta, nameField, phoneField, extraFields);
  const fullName = fields.fullName;
  const phone = fields.phone;
  const email = fields.email;
  const extraFieldsResolved = fields.extra;

  if (leadData.platform === "fb" || leadData.platform === "ig") {
    try {
      await db
        .update(facebookForms)
        .set({ platform: leadData.platform })
        .where(and(eq(facebookForms.userId, params.userId), eq(facebookForms.pageId, params.pageId), eq(facebookForms.formId, params.formId)));
    } catch { /* non-critical */ }
  }

  const rawDataForFields = rawData as Record<string, unknown> | null;
  const fieldDataArr = Array.isArray(rawDataForFields?.field_data)
    ? (rawDataForFields!.field_data as Array<{ name: string; values: string[] }>)
    : [];
  const extraFieldsJson = buildExtraFields(fieldDataArr);

  const rawDataRecord = rawData as Record<string, unknown> | null;
  const graphPlatform = rawDataRecord?.platform === "ig" ? "ig" : rawDataRecord?.platform === "fb" ? "fb" : null;
  const platformToWrite = graphPlatform ?? resolvedPlatform ?? undefined;

  await db
    .update(leads)
    .set({
      fullName,
      phone,
      email,
      rawData:      rawData ?? undefined,
      dataStatus:   "ENRICHED",
      deliveryStatus: "PROCESSING",
      dataError:    null,
      ...(platformToWrite ? { platform: platformToWrite } : {}),
      pageName,
      formName,
      campaignId:   rawDataRecord?.campaign_id   as string | null ?? null,
      campaignName: rawDataRecord?.campaign_name as string | null ?? null,
      adsetId:      rawDataRecord?.adset_id      as string | null ?? null,
      adsetName:    rawDataRecord?.adset_name    as string | null ?? null,
      adId:         rawDataRecord?.ad_id         as string | null ?? null,
      adName:       rawDataRecord?.ad_name       as string | null ?? null,
      extraFields:  extraFieldsJson,
    })
    .where(and(eq(leads.id, params.leadId), eq(leads.userId, params.userId)));

  const [leadRow] = await db.select().from(leads).where(eq(leads.id, params.leadId)).limit(1);
  if (!leadRow) throw new Error("Lead row missing after enrichment");

  const activeIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, params.userId), eq(integrations.isActive, true)));

  const leadPayload = {
    leadgenId: params.leadgenId,
    fullName,
    phone,
    email,
    pageId: params.pageId,
    formId: params.formId,
    extraFields: extraFieldsResolved,
  };

  for (const integration of activeIntegrations) {
    if (integration.type === "LEAD_ROUTING") {
      const intPageId = integration.pageId ?? "";
      const intFormId = integration.formId ?? "";
      if (intPageId !== params.pageId || intFormId !== params.formId) continue;
    }

    if (integration.type !== "AFFILIATE" && integration.type !== "LEAD_ROUTING") {
      continue;
    }

    // ── Multi-destination fan-out (LEAD_ROUTING + feature flag ON) ──────────
    // When the flag is on, resolve the full destination list and dispatch to
    // each one independently. Each destination gets its own `orders` row
    // keyed by `(leadId, integrationId, destinationId)`, so per-destination
    // retry state is tracked separately.
    //
    // If the resolver returns 0 rows (e.g. table not yet backfilled), we fall
    // through to the legacy single-destination path below — no regression.
    if (
      integration.type === "LEAD_ROUTING" &&
      isMultiDestinationsEnabled(integration.userId)
    ) {
      const destinations = await resolveIntegrationDestinations(db, {
        id: integration.id,
        userId: integration.userId,
        targetWebsiteId: integration.targetWebsiteId ?? null,
        config: integration.config,
      });

      if (destinations.length > 0) {
        for (const dest of destinations) {
          await deliverOneDestination({
            db,
            integration,
            // `mappingId` is the integration_destinations.id — used as
            // destinationId so each destination has its own order row.
            destinationId: dest.mappingId ?? 0,
            preResolvedDestination: dest,
            leadId: params.leadId,
            leadRow,
            leadPayload,
            userId: params.userId,
            pageId: params.pageId,
            isAdmin: params.isAdmin,
          });
        }
        // All destinations dispatched; skip the single-destination path.
        continue;
      }
      // If destinations is empty (no rows in integration_destinations yet),
      // fall through to the legacy single-dest path — `runOrderIntegrationSend`
      // will call the resolver again internally and handle the "no target" case.
    }

    // ── Legacy / AFFILIATE single-destination path ──────────────────────────
    // destinationId = 0 (the schema default). Preserves exact existing
    // behaviour for all non-flagged users and AFFILIATE integrations.
    await deliverOneDestination({
      db,
      integration,
      destinationId: 0,
      // Leave preResolvedDestination undefined so runOrderIntegrationSend
      // calls the resolver internally — identical to the pre-6b code path.
      preResolvedDestination: undefined,
      leadId: params.leadId,
      leadRow,
      leadPayload,
      userId: params.userId,
      pageId: params.pageId,
      isAdmin: params.isAdmin,
    });
  }

  await recalculateLeadDeliveryStatus(params.leadId, params.userId);

  await log.info("LEAD", `Processing complete — leadId=${params.leadId} fullName=${fullName ?? "unknown"} phone=${phone ?? "none"}`, { leadId: params.leadId, fullName, phone, email, pageId: params.pageId, formId: params.formId }, params.leadId, params.pageId, params.userId, "lead_enriched", "facebook");
}

/**
 * Re-deliver a single FAILED order whose nextRetryAt is due (Graph already ENRICHED).
 * Does not call Facebook Graph or processLead — routing only.
 * Uses optimistic locking on orders.attempts to avoid duplicate sends under concurrency.
 */
export async function retryFailedOrderDelivery(orderId: number): Promise<{
  outcome: "sent" | "failed_exhausted" | "failed_will_retry" | "skipped" | "lost_race";
}> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const now = new Date();

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.status, "FAILED"),
        lt(orders.attempts, ORDER_MAX_DELIVERY_ATTEMPTS),
        isNotNull(orders.nextRetryAt),
        lte(orders.nextRetryAt, now),
      ),
    )
    .limit(1);

  if (!order) return { outcome: "skipped" };

  const [lead] = await db.select().from(leads).where(eq(leads.id, order.leadId)).limit(1);
  if (!lead || lead.dataStatus !== "ENRICHED") return { outcome: "skipped" };

  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, order.integrationId), eq(integrations.userId, order.userId)))
    .limit(1);

  if (!integration) return { outcome: "skipped" };

  if (!integration.isActive) {
    await db.update(orders).set({ nextRetryAt: null }).where(eq(orders.id, order.id));
    await log.warn(
      "ORDER",
      `Order ${orderId} auto-retry paused — integration disabled`,
      { integrationId: integration.id },
      order.leadId,
      lead.pageId,
      order.userId,
      "order_retry_skipped",
      "system",
    );
    return { outcome: "skipped" };
  }

  if (integration.type === "LEAD_ROUTING") {
    const intPageId = integration.pageId ?? "";
    const intFormId = integration.formId ?? "";
    if (intPageId !== lead.pageId || intFormId !== lead.formId) return { outcome: "skipped" };
  }

  if (integration.type !== "AFFILIATE" && integration.type !== "LEAD_ROUTING") {
    return { outcome: "skipped" };
  }

  const extraFieldsResolved = (lead.extraFields as Record<string, string> | null) ?? {};
  const leadPayload = {
    leadgenId: lead.leadgenId,
    fullName: lead.fullName,
    phone: lead.phone,
    email: lead.email,
    pageId: lead.pageId,
    formId: lead.formId,
    extraFields: extraFieldsResolved,
  };

  // When the order was created by the multi-destination fan-out path, it
  // carries `destinationId > 0` pointing to the specific
  // `integration_destinations` row it was dispatched to. On retry we must
  // re-dispatch to the SAME destination, not let the resolver pick a
  // potentially different one.
  //
  // If `destinationId === 0` this is a legacy order — let
  // `runOrderIntegrationSend` resolve the destination internally (existing
  // behaviour, no change).
  let preResolvedDestination: ResolvedDestination | undefined;
  if (order.destinationId > 0) {
    const [destRow] = await db
      .select({ mapping: integrationDestinations, tw: targetWebsites })
      .from(integrationDestinations)
      .innerJoin(
        targetWebsites,
        eq(integrationDestinations.targetWebsiteId, targetWebsites.id),
      )
      .where(
        and(
          eq(integrationDestinations.id, order.destinationId),
          eq(integrationDestinations.integrationId, integration.id),
        ),
      )
      .limit(1);

    if (!destRow) {
      // The destination mapping was deleted after the order was created.
      // Cancel retries for this order so the scheduler doesn't keep picking it.
      await db.update(orders).set({ nextRetryAt: null }).where(eq(orders.id, order.id));
      await log.warn(
        "ORDER",
        `Order ${order.id} auto-retry skipped — destination mapping ${order.destinationId} not found`,
        { integrationId: integration.id, destinationId: order.destinationId },
        order.leadId,
        lead.pageId,
        order.userId,
        "order_retry_skipped",
        "system",
      );
      return { outcome: "skipped" };
    }

    if (!destRow.mapping.enabled) {
      await db.update(orders).set({ nextRetryAt: null }).where(eq(orders.id, order.id));
      await log.warn(
        "ORDER",
        `Order ${order.id} auto-retry paused — destination mapping ${order.destinationId} disabled`,
        { integrationId: integration.id, destinationId: order.destinationId },
        order.leadId,
        lead.pageId,
        order.userId,
        "order_retry_skipped",
        "system",
      );
      return { outcome: "skipped" };
    }

    // Ownership guard — must match integration owner to avoid cross-tenant dispatch.
    if (destRow.tw.userId !== order.userId) {
      await db.update(orders).set({ nextRetryAt: null }).where(eq(orders.id, order.id));
      return { outcome: "skipped" };
    }

    preResolvedDestination = {
      mappingId: destRow.mapping.id,
      position: destRow.mapping.position,
      enabled: destRow.mapping.enabled,
      targetWebsite: destRow.tw,
    };
  }

  const prevAttempts = order.attempts;
  const result = await runOrderIntegrationSend({
    db,
    integration,
    lead,
    leadPayload,
    userId: order.userId,
    isAdmin: false,
    deliverySource: "auto_retry",
    deliveryAttempt: { current: prevAttempts + 1, max: ORDER_MAX_DELIVERY_ATTEMPTS },
    // Pass the pre-resolved destination for fan-out orders; undefined for legacy
    // orders so the internal resolver runs as before.
    preResolvedDestination,
  });

  const persisted = await persistOrderDeliveryAttemptResult(db, { orderId: order.id, prevAttempts, result });
  if (!persisted) return { outcome: "lost_race" };

  await recalculateLeadDeliveryStatus(lead.id);

  if (result.success) return { outcome: "sent" };
  const [after] = await db.select({ attempts: orders.attempts }).from(orders).where(eq(orders.id, order.id)).limit(1);
  if (after && after.attempts >= ORDER_MAX_DELIVERY_ATTEMPTS) return { outcome: "failed_exhausted" };
  return { outcome: "failed_will_retry" };
}

import { and, desc, eq, isNotNull, lt, lte } from "drizzle-orm";
import { facebookConnections, facebookAccounts, facebookForms, leads, orders, integrations, users, targetWebsites } from "../../drizzle/schema";
import { getDb } from "../db";
import { decrypt } from "../encryption";
import { fetchLeadData, extractLeadFields } from "./facebookService";
import { sendTelegramNotification, type TelegramConfig } from "./telegramService";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";
import { sendAffiliateOrder, sendAffiliateOrderByTemplate, type AffiliateConfig, type TemplateType, type TemplateConfig } from "./affiliateService";
import { formatLeadMessage } from "./telegramFormatter";
import { log, logEvent } from "./appLogger";
import { aggregateLeadDeliveryFromOrderStatuses } from "../lib/leadPipeline";
import { ORDER_MAX_DELIVERY_ATTEMPTS, ORDER_RETRY_INTERVAL_MS } from "../lib/orderRetryPolicy";

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
 * Validate that a target URL is safe to send requests to.
 * Rejects non-HTTPS, localhost, and RFC1918 private ranges to prevent SSRF.
 */
function assertSafeTargetUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("targetUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("targetUrl must use HTTPS — plain HTTP is not allowed");
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = [
    "localhost", "127.0.0.1", "0.0.0.0", "::1",
    // Link-local
    "169.254.",
    // RFC1918 private ranges
    "10.", "192.168.",
    // RFC1918 172.16.0.0/12
    ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.`),
  ];
  if (blocked.some((b) => host === b.replace(/\.$/, "") || host.startsWith(b))) {
    throw new Error("targetUrl must not target internal or private network addresses");
  }
}

/**
 * Send lead to a LEAD_ROUTING target website.
 */
async function sendLeadToTargetWebsite(
  config: Record<string, unknown>,
  payload: {
    fullName: string | null;
    phone: string | null;
    email: string | null;
    leadgenId: string;
    pageId: string;
    formId: string;
    extraFields?: Record<string, string>;
  }
): Promise<{ success: boolean; responseData?: unknown; error?: string }> {
  const { targetUrl, targetHeaders, flow, offerId } = config as {
    targetUrl?: string;
    targetHeaders?: Record<string, string>;
    flow?: string;
    offerId?: string;
  };

  if (!targetUrl) {
    return { success: false, error: "No targetUrl configured in LEAD_ROUTING integration" };
  }

  try {
    assertSafeTargetUrl(targetUrl);
  } catch (err) {
    return { success: false, error: `Invalid targetUrl: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const body = {
      // Extra fields first so core fields always override them
      ...(payload.extraFields ?? {}),
      name: payload.fullName,
      phone: payload.phone,
      email: payload.email,
      flow: flow ?? "",
      offer_id: offerId ?? "",
      leadgen_id: payload.leadgenId,
      page_id: payload.pageId,
      form_id: payload.formId,
    };

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(targetHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    const text = await res.text();
    let responseData: unknown;
    try { responseData = JSON.parse(text); } catch { responseData = text; }

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}`, responseData };
    }
    return { success: true, responseData };
  } catch (err) {
    return { success: false, error: String(err) };
  }
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
};

async function persistOrderDeliveryAttemptResult(
  db: DbClient,
  params: { orderId: number; prevAttempts: number; result: IntegrationDeliveryResult },
): Promise<boolean> {
  const { orderId, prevAttempts, result } = params;
  const now = new Date();
  const newAttempts = prevAttempts + 1;
  const nextRetry =
    result.success || newAttempts >= ORDER_MAX_DELIVERY_ATTEMPTS
      ? null
      : new Date(now.getTime() + ORDER_RETRY_INTERVAL_MS);

  const common = {
    attempts: newAttempts,
    lastAttemptAt: now,
    responseData: (result.responseData ?? { error: result.error }) as Record<string, unknown>,
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
  return n === 1;
}

/**
 * Send one order to its integration (Graph already done — routing only).
 * Shared by processLead and the hourly order retry job.
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
}): Promise<IntegrationDeliveryResult> {
  const { db, integration, lead, leadPayload, userId, isAdmin } = params;
  const deliverySource = params.deliverySource ?? "initial";
  let result: IntegrationDeliveryResult;

  if (integration.type === "TELEGRAM") {
    const config = integration.config as TelegramConfig;
    result = await sendTelegramNotification(
      config,
      {
        ...leadPayload,
        formId: lead.formId ?? "",
        createdAt: lead.createdAt ?? new Date(),
      },
      { isAutoRetry: deliverySource === "auto_retry" },
    );
    await log[result.success ? "info" : "warn"](
      "TELEGRAM",
      result.success ? `Telegram notification sent for leadId=${lead.id}` : `Telegram notification failed for leadId=${lead.id}`,
      { integrationId: integration.id, error: result.error },
      lead.id,
      leadPayload.pageId,
      userId,
      "sent_to_telegram",
      "facebook",
    );
  } else if (integration.type === "AFFILIATE") {
    const config = integration.config as AffiliateConfig;
    const _t0Affiliate = Date.now();
    result = await sendAffiliateOrder(config, leadPayload);
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
    const twId = integration.targetWebsiteId ?? (config.targetWebsiteId ? Number(config.targetWebsiteId) : null);
    if (twId) {
      const { targetWebsites, destinationTemplates } = await import("../../drizzle/schema");
      const [tw] = await db.select().from(targetWebsites).where(eq(targetWebsites.id, twId)).limit(1);
      if (tw && tw.userId !== userId) {
        result = { success: false, error: "Target website owner mismatch" };
      } else {
        destinationTelegramChatId = (tw as { telegramChatId?: string | null } | undefined)?.telegramChatId?.trim?.() ?? null;
        const variableFields = (config.variableFields as Record<string, string> | undefined) ?? {};
        if (tw && tw.templateId) {
          const { sendLeadViaTemplate } = await import("./affiliateService");
          const [dynTpl] = await db
            .select()
            .from(destinationTemplates)
            .where(eq(destinationTemplates.id, tw.templateId))
            .limit(1);
          if (dynTpl) {
            targetUrlUsed = dynTpl.endpointUrl ?? undefined;
            result = await sendLeadViaTemplate(dynTpl, tw.templateConfig, leadPayload, variableFields);
          } else {
            targetUrlUsed = undefined;
            result = { success: false, error: `Template ${tw.templateId} not found` };
          }
        } else if (tw && tw.templateType) {
          targetUrlUsed = (tw.url as string | null) ?? undefined;
          result = await sendAffiliateOrderByTemplate(
            tw.templateType as TemplateType,
            tw.templateConfig as TemplateConfig,
            leadPayload,
            variableFields,
            tw.url,
          );
        } else {
          targetUrlUsed = (config.targetUrl as string | undefined) ?? undefined;
          result = await sendLeadToTargetWebsite(config, leadPayload);
        }
      }
    } else {
      targetUrlUsed = (config.targetUrl as string | undefined) ?? undefined;
      result = await sendLeadToTargetWebsite(config, leadPayload);
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
    result = { success: false, error: `Unsupported integration type: ${integration.type}` };
  }

  return result;
}

export async function recalculateLeadDeliveryStatus(leadId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db.select({ status: orders.status }).from(orders).where(eq(orders.leadId, leadId));
  const deliveryStatus = aggregateLeadDeliveryFromOrderStatuses(
    rows.map((r) => r.status as "PENDING" | "SENT" | "FAILED"),
  );
  await db.update(leads).set({ deliveryStatus }).where(eq(leads.id, leadId));
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
      .where(eq(leads.id, params.leadId));
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
      .where(eq(leads.id, params.leadId));
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
      nameField = config.nameField as string | undefined;
      phoneField = config.phoneField as string | undefined;
      extraFields = config.extraFields as typeof extraFields | undefined;
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
    .where(eq(leads.id, params.leadId));

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

    if (integration.type !== "TELEGRAM" && integration.type !== "AFFILIATE" && integration.type !== "LEAD_ROUTING") {
      continue;
    }

    const [existingOrder] = await db
      .select({
        id: orders.id,
        status: orders.status,
        attempts: orders.attempts,
        nextRetryAt: orders.nextRetryAt,
      })
      .from(orders)
      .where(and(eq(orders.leadId, params.leadId), eq(orders.integrationId, integration.id)))
      .limit(1);

    if (existingOrder?.status === "SENT") continue;

    if (existingOrder?.status === "FAILED") {
      if (existingOrder.attempts >= ORDER_MAX_DELIVERY_ATTEMPTS) continue;
      if (existingOrder.nextRetryAt && existingOrder.nextRetryAt > new Date()) continue;
    }

    let orderId: number;
    let prevAttempts: number;

    if (!existingOrder) {
      await db.insert(orders).values({
        leadId: params.leadId,
        userId: params.userId,
        integrationId: integration.id,
        status: "PENDING",
        attempts: 0,
      });
      const [row] = await db
        .select({ id: orders.id, attempts: orders.attempts })
        .from(orders)
        .where(and(eq(orders.leadId, params.leadId), eq(orders.integrationId, integration.id)))
        .limit(1);
      if (!row) continue;
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
      userId: params.userId,
      isAdmin: params.isAdmin,
    });

    const persisted = await persistOrderDeliveryAttemptResult(db, { orderId, prevAttempts, result });
    if (!persisted) {
      await log.warn(
        "ORDER",
        `Order ${orderId} delivery result not persisted (concurrent update)`,
        { orderId, prevAttempts },
        params.leadId,
        params.pageId,
        params.userId,
        "order_delivery_race",
        "facebook",
      );
    }
  }

  await recalculateLeadDeliveryStatus(params.leadId);

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

  if (integration.type !== "TELEGRAM" && integration.type !== "AFFILIATE" && integration.type !== "LEAD_ROUTING") {
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
  });

  const persisted = await persistOrderDeliveryAttemptResult(db, { orderId: order.id, prevAttempts, result });
  if (!persisted) return { outcome: "lost_race" };

  await recalculateLeadDeliveryStatus(lead.id);

  if (result.success) return { outcome: "sent" };
  const [after] = await db.select({ attempts: orders.attempts }).from(orders).where(eq(orders.id, order.id)).limit(1);
  if (after && after.attempts >= ORDER_MAX_DELIVERY_ATTEMPTS) return { outcome: "failed_exhausted" };
  return { outcome: "failed_will_retry" };
}

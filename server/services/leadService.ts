import { and, eq } from "drizzle-orm";
import { facebookConnections, facebookAccounts, facebookForms, leads, orders, integrations, users, targetWebsites } from "../../drizzle/schema";
import { getDb } from "../db";
import { decrypt } from "../encryption";
import { fetchLeadData, extractLeadFields } from "./facebookService";
import { sendTelegramNotification, type TelegramConfig } from "./telegramService";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";
import { sendAffiliateOrder, sendAffiliateOrderByTemplate, type AffiliateConfig, type TemplateType, type TemplateConfig } from "./affiliateService";
import { formatLeadMessage } from "./telegramFormatter";
import { log, logEvent } from "./appLogger";

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
        status:   "PENDING",
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
      const accountId = config.accountId as number | undefined;
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
  const [connection] = await db
    .select()
    .from(facebookConnections)
    .where(and(eq(facebookConnections.pageId, pageId), eq(facebookConnections.userId, userId)))
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
  integration: { telegramChatId?: string | null; name: string; type: string };
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
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Determine destination chat ID
  let chatId: string | null = params.integration.telegramChatId ?? null;
  if (!chatId) {
    const [user] = await db.select({ telegramChatId: users.telegramChatId }).from(users).where(eq(users.id, params.userId)).limit(1);
    chatId = user?.telegramChatId ?? null;
  }
  if (!chatId) return; // No Telegram configured for this user

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
  });

  await sendTelegramMessage(chatId, html, "HTML");
}

/**
 * Full lead processing pipeline:
 * 1. Resolve page access token (LEAD_ROUTING config → facebookAccounts → legacy facebookConnections)
 * 2. Fetch lead data from Facebook Graph API
 * 3. Extract fields using custom mapping if LEAD_ROUTING integration exists
 * 4. Update lead record with enriched data
 * 5. Create orders for all active integrations
 * 6. Dispatch to Telegram / Affiliate / LEAD_ROUTING target website
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

  // Step 1: Resolve access token
  const accessToken = await resolvePageAccessToken(params.pageId, params.formId, params.userId);

  let fullName: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;
  let rawData: unknown = null;
  let extraFieldsResolved: Record<string, string> = {};

  // Step 2: Fetch lead data from Graph API
  if (accessToken) {
    const leadData = await fetchLeadData(params.leadgenId, accessToken);
    if (leadData) {
      rawData = leadData;

      // Find matching LEAD_ROUTING integration for custom field mapping
      // Use dedicated columns (indexed) with config JSON fallback
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
      fullName = fields.fullName;
      phone = fields.phone;
      email = fields.email;
      extraFieldsResolved = fields.extra;

      // If Graph API returned platform field, update facebook_forms for accuracy
      if (leadData.platform === "fb" || leadData.platform === "ig") {
        try {
          await db
            .update(facebookForms)
            .set({ platform: leadData.platform })
            .where(and(eq(facebookForms.userId, params.userId), eq(facebookForms.pageId, params.pageId), eq(facebookForms.formId, params.formId)));
        } catch { /* non-critical */ }
      }
    }
  } else {
    await log.warn("LEAD", `No access token found — lead data cannot be fetched`, { pageId: params.pageId, formId: params.formId }, params.leadId, params.pageId, params.userId, "lead_enriched", "facebook");
  }

  // Resolve pageName/formName for denormalized columns (tenant-safe)
  let pageName: string | null = null;
  let formName: string | null = null;
  try {
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
    pageName = formRow?.pageName ?? null;
    formName = formRow?.formName ?? null;
  } catch { /* non-critical — lead still processed without page/form name */ }

  // Extract extra field_data values (everything except full_name + phone_number)
  const rawDataForFields = rawData as Record<string, unknown> | null;
  const fieldDataArr = Array.isArray(rawDataForFields?.field_data)
    ? (rawDataForFields!.field_data as Array<{ name: string; values: string[] }>)
    : [];
  const extraFieldsJson = buildExtraFields(fieldDataArr);

  // Step 3: Update lead with all enriched data (single write, no further updates)
  const rawDataRecord = rawData as Record<string, unknown> | null;
  await db
    .update(leads)
    .set({
      fullName,
      phone,
      email,
      rawData:      rawData ?? undefined,
      status:       "RECEIVED",
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

  // Step 4: Get active integrations for this user
  // For LEAD_ROUTING: filter directly by dedicated pageId/formId columns (uses index)
  // For TELEGRAM/AFFILIATE: no page filter needed — they receive all leads
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

  // Step 5: Process each integration
  for (const integration of activeIntegrations) {
    // For LEAD_ROUTING, only process if page+form matches
    // Use dedicated columns (indexed)
    if (integration.type === "LEAD_ROUTING") {
      const intPageId = integration.pageId ?? "";
      const intFormId = integration.formId ?? "";
      if (intPageId !== params.pageId || intFormId !== params.formId) continue;
    }

    // Create order record
    await db.insert(orders).values({
      leadId: params.leadId,
      userId: params.userId,
      integrationId: integration.id,
      status: "PENDING",
      retryCount: 0,
    });

    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.leadId, params.leadId), eq(orders.integrationId, integration.id)))
      .limit(1);

    if (!order) continue;

    let result: { success: boolean; responseData?: unknown; error?: string; durationMs?: number };
    if (integration.type === "TELEGRAM") {
      const config = integration.config as TelegramConfig;
      const [lead] = await db.select().from(leads).where(eq(leads.id, params.leadId)).limit(1);
      result = await sendTelegramNotification(config, {
        ...leadPayload,
        formId: lead?.formId ?? "",
        createdAt: lead?.createdAt ?? new Date(),
      });
      await log[result.success ? "info" : "warn"]("TELEGRAM", result.success ? `Telegram notification sent for leadId=${params.leadId}` : `Telegram notification failed for leadId=${params.leadId}`, { integrationId: integration.id, error: result.error }, params.leadId, params.pageId, params.userId, "sent_to_telegram", "facebook");
    } else if (integration.type === "AFFILIATE") {
      const config = integration.config as AffiliateConfig;
      const _t0Affiliate = Date.now();
      result = await sendAffiliateOrder(config, leadPayload);
      result.durationMs = Date.now() - _t0Affiliate;
      await log[result.success ? "info" : "warn"]("AFFILIATE", result.success ? `Affiliate order sent for leadId=${params.leadId}` : `Affiliate order failed for leadId=${params.leadId}`, { integrationId: integration.id, error: result.error }, params.leadId, params.pageId, params.userId, "sent_to_affiliate", "facebook", result.durationMs);
      // Send Telegram notification after affiliate result
      await sendLeadTelegramNotification({
        integration,
        userId: params.userId,
        lead: { fullName, phone, email, pageId: params.pageId, formId: params.formId, leadgenId: params.leadgenId },
        result,
        isAdmin: params.isAdmin ?? false,
      });
    } else if (integration.type === "LEAD_ROUTING") {
      const config = integration.config as Record<string, unknown>;
      const _t0Routing = Date.now();
      // If targetWebsiteId is set, look up the target website and use template-based dispatch
      const twId = integration.targetWebsiteId ?? (config.targetWebsiteId ? Number(config.targetWebsiteId) : null);
      if (twId) {
        const { targetWebsites } = await import("../../drizzle/schema");
        const [tw] = await db.select().from(targetWebsites).where(eq(targetWebsites.id, twId)).limit(1);
        // Extract variable fields from integration config (set per routing rule)
        const variableFields = (config.variableFields as Record<string, string> | undefined) ?? {};
        if (tw && tw.templateType) {
          result = await sendAffiliateOrderByTemplate(
            tw.templateType as TemplateType,
            tw.templateConfig as TemplateConfig,
            leadPayload,
            variableFields,
            tw.url  // pass site.url for custom templates
          );
        } else {
          result = await sendLeadToTargetWebsite(config, leadPayload);
        }
      } else {
        result = await sendLeadToTargetWebsite(config, leadPayload);
      }
      result.durationMs = Date.now() - _t0Routing;
      await log[result.success ? "info" : "warn"]("ORDER", result.success ? `Lead routed to target website for leadId=${params.leadId}` : `Lead routing failed for leadId=${params.leadId}`, { integrationId: integration.id, targetUrl: (config as Record<string,unknown>).targetUrl, error: result.error }, params.leadId, params.pageId, params.userId, "sent_to_target_website", "facebook", result.durationMs);
      // Send Telegram notification after lead routing result
      await sendLeadTelegramNotification({
        integration,
        userId: params.userId,
        lead: { fullName, phone, email, pageId: params.pageId, formId: params.formId, leadgenId: params.leadgenId },
        result,
        isAdmin: params.isAdmin ?? false,
      });
    } else {
      continue;
    }

    // Update order status
    await db
      .update(orders)
      .set({
        status: result.success ? "SENT" : "FAILED",
        responseData: result.responseData ?? { error: result.error },
      })
      .where(eq(orders.id, order.id));
  }

  await log.info("LEAD", `Processing complete — leadId=${params.leadId} fullName=${fullName ?? "unknown"} phone=${phone ?? "none"}`, { leadId: params.leadId, fullName, phone, email, pageId: params.pageId, formId: params.formId }, params.leadId, params.pageId, params.userId, "lead_enriched", "facebook");
}

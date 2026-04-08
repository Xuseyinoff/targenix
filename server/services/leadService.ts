import { and, eq } from "drizzle-orm";
import {
  facebookConnections,
  facebookAccounts,
  facebookForms,
  leads,
  orders,
  integrations,
  users,
  targetWebsites,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { decrypt } from "../encryption";
import { fetchLeadData, extractLeadFields } from "./facebookService";
import { sendTelegramNotification, type TelegramConfig } from "./telegramService";
import { sendTelegramMessage } from "../webhooks/telegramWebhook";
import {
  sendAffiliateOrder,
  sendAffiliateOrderByTemplate,
  type AffiliateConfig,
  type TemplateType,
  type TemplateConfig,
} from "./affiliateService";
import { formatLeadMessage } from "./telegramFormatter";
import { log } from "./appLogger";

/**
 * Save an incoming lead to the database with PENDING status.
 * Called from the webhook handler â€” must be fast.
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
    const rawDataObj = params.rawData as Record<string, unknown> | null;
    const platform = (rawDataObj?.platform === "ig" ? "ig" : "fb") as "fb" | "ig";

    await db
      .insert(leads)
      .values({
        userId: params.userId,
        pageId: params.pageId,
        formId: params.formId,
        leadgenId: params.leadgenId,
        rawData: params.rawData,
        platform,
        status: "PENDING",
      })
      .onDuplicateKeyUpdate({ set: { rawData: params.rawData, platform } });

    const [saved] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.leadgenId, params.leadgenId), eq(leads.userId, params.userId)))
      .limit(1);

    await log.info(
      "LEAD",
      `Lead saved â€” id=${saved?.id} leadgenId=${params.leadgenId}`,
      { leadgenId: params.leadgenId, pageId: params.pageId, formId: params.formId },
      saved?.id ?? null,
      params.pageId,
      params.userId,
      "lead_saved",
      "facebook"
    );
    return saved?.id ?? null;
  } catch (err) {
    await log.error(
      "LEAD",
      `Failed to save lead â€” leadgenId=${params.leadgenId}`,
      { error: String(err), stack: err instanceof Error ? err.stack : undefined },
      null,
      params.pageId,
      params.userId,
      "error",
      "facebook"
    );
    return null;
  }
}

/**
 * Resolve an access token for a page.
 * Priority: LEAD_ROUTING integration config â†’ facebookAccounts â†’ facebookConnections (legacy)
 */
async function resolvePageAccessToken(
  pageId: string,
  formId: string,
  userId: number
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const allIntegrations = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.userId, userId),
        eq(integrations.isActive, true),
        eq(integrations.pageId, pageId),
        eq(integrations.formId, formId)
      )
    );

  for (const integration of allIntegrations) {
    if (integration.type !== "LEAD_ROUTING") continue;
    const config = integration.config as Record<string, unknown>;
    const intPageId = integration.pageId ?? "";
    const intFormId = integration.formId ?? "";
    if (intPageId === pageId && intFormId === formId) {
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

function extractWithMapping(
  fieldData: Array<{ name: string; values: string[] }>,
  nameField?: string,
  phoneField?: string
): { fullName: string | null; phone: string | null; email: string | null } {
  const get = (key: string) => {
    const f = fieldData.find((d) => d.name === key);
    return f?.values?.[0] ?? null;
  };

  if (nameField || phoneField) {
    return {
      fullName: nameField ? get(nameField) : null,
      phone: phoneField ? get(phoneField) : null,
      email: get("email"),
    };
  }

  return extractLeadFields(fieldData);
}

async function sendLeadToTargetWebsite(
  config: Record<string, unknown>,
  payload: {
    fullName: string | null;
    phone: string | null;
    email: string | null;
    leadgenId: string;
    pageId: string;
    formId: string;
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
    const body = {
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
    try {
      responseData = JSON.parse(text);
    } catch {
      responseData = text;
    }

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}`, responseData };
    }
    return { success: true, responseData };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

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

  let chatId: string | null = params.integration.telegramChatId ?? null;
  if (!chatId) {
    const [user] = await db
      .select({ telegramChatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    chatId = user?.telegramChatId ?? null;
  }
  if (!chatId) return;

  let pageName: string | null = null;
  let accountName: string | null = null;
  let formName: string | null = null;
  let targetWebsiteName: string | null = null;

  try {
    const [conn] = await db
      .select({ pageName: facebookConnections.pageName })
      .from(facebookConnections)
      .where(and(eq(facebookConnections.pageId, params.lead.pageId), eq(facebookConnections.userId, params.userId)))
      .limit(1);
    pageName = conn?.pageName ?? null;

    const allIntegrations = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.userId, params.userId),
          eq(integrations.isActive, true),
          eq(integrations.pageId, params.lead.pageId),
          eq(integrations.formId, params.lead.formId)
        )
      );

    for (const intg of allIntegrations) {
      if (intg.type !== "LEAD_ROUTING") continue;
      const cfg = intg.config as Record<string, unknown>;
      const intPageId = intg.pageId ?? "";
      const intFormId = intg.formId ?? "";
      if (intPageId === params.lead.pageId && intFormId === params.lead.formId) {
        formName = intg.formName ?? (cfg.formName as string | undefined) ?? null;
        const accountId = (cfg.facebookAccountId ?? cfg.accountId) as number | undefined;
        if (accountId) {
          const [acct] = await db
            .select({ fbUserName: facebookAccounts.fbUserName })
            .from(facebookAccounts)
            .where(eq(facebookAccounts.id, accountId))
            .limit(1);
          accountName = acct?.fbUserName ?? null;
        }
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
    // Non-critical.
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

export async function processLead(params: {
  leadId: number;
  leadgenId: string;
  pageId: string;
  formId: string;
  userId: number;
  isAdmin?: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  let fullName: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;
  let rawData: unknown = null;
  let hasFailedDispatch = false;

  try {
    const accessToken = await resolvePageAccessToken(params.pageId, params.formId, params.userId);

    if (accessToken) {
      const leadData = await fetchLeadData(params.leadgenId, accessToken);
      if (leadData) {
        rawData = leadData;

        const allIntegrations = await db
          .select()
          .from(integrations)
          .where(
            and(
              eq(integrations.userId, params.userId),
              eq(integrations.isActive, true),
              eq(integrations.pageId, params.pageId),
              eq(integrations.formId, params.formId)
            )
          );

        let nameField: string | undefined;
        let phoneField: string | undefined;

        for (const integration of allIntegrations) {
          if (integration.type !== "LEAD_ROUTING") continue;
          const config = integration.config as Record<string, unknown>;
          const intPageId = integration.pageId ?? "";
          const intFormId = integration.formId ?? "";
          if (intPageId === params.pageId && intFormId === params.formId) {
            nameField = config.nameField as string | undefined;
            phoneField = config.phoneField as string | undefined;
            break;
          }
        }

        const fields = extractWithMapping(leadData.field_data, nameField, phoneField);
        fullName = fields.fullName;
        phone = fields.phone;
        email = fields.email;

        if (leadData.platform === "fb" || leadData.platform === "ig") {
          try {
            await db
              .update(facebookForms)
              .set({ platform: leadData.platform })
              .where(
                and(
                  eq(facebookForms.userId, params.userId),
                  eq(facebookForms.pageId, params.pageId),
                  eq(facebookForms.formId, params.formId)
                )
              );
          } catch {
            // Non-critical.
          }
        }
      }
    } else {
      await log.warn(
        "LEAD",
        "No access token found â€” lead data cannot be fetched",
        { pageId: params.pageId, formId: params.formId },
        params.leadId,
        params.pageId,
        params.userId,
        "lead_enriched",
        "facebook"
      );
    }

    await db
      .update(leads)
      .set({
        fullName,
        phone,
        email,
        rawData: rawData ?? undefined,
        status: "PENDING",
      })
      .where(eq(leads.id, params.leadId));

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
    };

    for (const integration of activeIntegrations) {
      if (integration.type === "LEAD_ROUTING") {
        const intPageId = integration.pageId ?? "";
        const intFormId = integration.formId ?? "";
        if (intPageId !== params.pageId || intFormId !== params.formId) continue;
      }

      const insertResult = await db.insert(orders).values({
        leadId: params.leadId,
        userId: params.userId,
        integrationId: integration.id,
        status: "PENDING",
        retryCount: 0,
      });

      const orderId =
        ((insertResult as Array<{ insertId?: number }>)?.[0]?.insertId) ??
        (insertResult as { insertId?: number })?.insertId;
      if (!orderId) continue;

      let result: { success: boolean; responseData?: unknown; error?: string; durationMs?: number };
      if (integration.type === "TELEGRAM") {
        const config = integration.config as TelegramConfig;
        const [lead] = await db.select().from(leads).where(eq(leads.id, params.leadId)).limit(1);
        result = await sendTelegramNotification(config, {
          ...leadPayload,
          formId: lead?.formId ?? "",
          createdAt: lead?.createdAt ?? new Date(),
        });
        await log[result.success ? "info" : "warn"](
          "TELEGRAM",
          result.success
            ? `Telegram notification sent for leadId=${params.leadId}`
            : `Telegram notification failed for leadId=${params.leadId}`,
          { integrationId: integration.id, error: result.error },
          params.leadId,
          params.pageId,
          params.userId,
          "sent_to_telegram",
          "facebook"
        );
      } else if (integration.type === "AFFILIATE") {
        const config = integration.config as AffiliateConfig;
        const startedAt = Date.now();
        result = await sendAffiliateOrder(config, leadPayload);
        result.durationMs = Date.now() - startedAt;
        await log[result.success ? "info" : "warn"](
          "AFFILIATE",
          result.success
            ? `Affiliate order sent for leadId=${params.leadId}`
            : `Affiliate order failed for leadId=${params.leadId}`,
          { integrationId: integration.id, error: result.error },
          params.leadId,
          params.pageId,
          params.userId,
          "sent_to_affiliate",
          "facebook",
          result.durationMs
        );
        await sendLeadTelegramNotification({
          integration,
          userId: params.userId,
          lead: {
            fullName,
            phone,
            email,
            pageId: params.pageId,
            formId: params.formId,
            leadgenId: params.leadgenId,
          },
          result,
          isAdmin: params.isAdmin ?? false,
        });
      } else if (integration.type === "LEAD_ROUTING") {
        const config = integration.config as Record<string, unknown>;
        const startedAt = Date.now();
        const twId = integration.targetWebsiteId ?? (config.targetWebsiteId ? Number(config.targetWebsiteId) : null);
        if (twId) {
          const { targetWebsites } = await import("../../drizzle/schema");
          const [tw] = await db.select().from(targetWebsites).where(eq(targetWebsites.id, twId)).limit(1);
          const variableFields = (config.variableFields as Record<string, string> | undefined) ?? {};
          if (tw && tw.templateType) {
            result = await sendAffiliateOrderByTemplate(
              tw.templateType as TemplateType,
              tw.templateConfig as TemplateConfig,
              leadPayload,
              variableFields,
              tw.url
            );
          } else {
            result = await sendLeadToTargetWebsite(config, leadPayload);
          }
        } else {
          result = await sendLeadToTargetWebsite(config, leadPayload);
        }
        result.durationMs = Date.now() - startedAt;
        await log[result.success ? "info" : "warn"](
          "ORDER",
          result.success
            ? `Lead routed to target website for leadId=${params.leadId}`
            : `Lead routing failed for leadId=${params.leadId}`,
          {
            integrationId: integration.id,
            targetUrl: (config as Record<string, unknown>).targetUrl,
            error: result.error,
          },
          params.leadId,
          params.pageId,
          params.userId,
          "sent_to_target_website",
          "facebook",
          result.durationMs
        );
        await sendLeadTelegramNotification({
          integration,
          userId: params.userId,
          lead: {
            fullName,
            phone,
            email,
            pageId: params.pageId,
            formId: params.formId,
            leadgenId: params.leadgenId,
          },
          result,
          isAdmin: params.isAdmin ?? false,
        });
      } else {
        continue;
      }

      if (!result.success) {
        hasFailedDispatch = true;
      }

      await db
        .update(orders)
        .set({
          status: result.success ? "SENT" : "FAILED",
          responseData: result.responseData ?? { error: result.error },
        })
        .where(eq(orders.id, orderId));
    }

    await db
      .update(leads)
      .set({ status: hasFailedDispatch ? "FAILED" : "RECEIVED" })
      .where(eq(leads.id, params.leadId));

    await log[hasFailedDispatch ? "warn" : "info"](
      "LEAD",
      hasFailedDispatch
        ? `Processing finished with failures â€” leadId=${params.leadId}`
        : `Processing complete â€” leadId=${params.leadId} fullName=${fullName ?? "unknown"} phone=${phone ?? "none"}`,
      { leadId: params.leadId, fullName, phone, email, pageId: params.pageId, formId: params.formId },
      params.leadId,
      params.pageId,
      params.userId,
      "lead_enriched",
      "facebook"
    );
  } catch (err) {
    await db
      .update(leads)
      .set({ status: "FAILED" })
      .where(eq(leads.id, params.leadId));

    await log.error(
      "LEAD",
      `Processing crashed â€” leadId=${params.leadId}`,
      { error: String(err), stack: err instanceof Error ? err.stack : undefined },
      params.leadId,
      params.pageId,
      params.userId,
      "error",
      "facebook"
    );

    throw err;
  }
}

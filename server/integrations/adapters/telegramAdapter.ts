import { decrypt } from "../../encryption";
import { injectVariables, type LeadPayload } from "../../services/affiliateService";
import { sendTelegramRawMessage } from "../../services/telegramService";
import type { DeliveryResult } from "../types";

interface TelegramLeadRow {
  pageName?: string | null;
  formName?: string | null;
  campaignName?: string | null;
  createdAt?: Date | null;
}

interface TelegramAdapterConfig {
  templateConfig: { botTokenEncrypted?: string; chatId?: string; messageTemplate?: string };
  leadRow: TelegramLeadRow;
}

export const telegramAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { templateConfig: cfg, leadRow } = config as TelegramAdapterConfig;

    if (!cfg.botTokenEncrypted || !cfg.chatId) {
      return {
        success: false,
        error: "Telegram destination missing botToken or chatId",
        errorType: "validation",
      };
    }

    const token = decrypt(cfg.botTokenEncrypted);
    const ctx: Record<string, string> = {};
    if (lead.fullName)        ctx.full_name     = lead.fullName;
    if (lead.phone)           ctx.phone_number  = lead.phone;
    if (lead.email)           ctx.email         = lead.email;
    if (leadRow.pageName)     ctx.pageName      = leadRow.pageName;
    if (leadRow.formName)     ctx.formName      = leadRow.formName;
    if (leadRow.campaignName) ctx.campaignName  = leadRow.campaignName;
    if (leadRow.createdAt)    ctx.createdAt     = new Date(leadRow.createdAt).toLocaleString("uz-UZ");
    Object.assign(ctx, lead.extraFields ?? {});

    const messageTemplate = cfg.messageTemplate
      || "📋 Yangi lead\n\n👤 Ism: {{full_name}}\n📞 Telefon: {{phone_number}}\n📧 Email: {{email}}";
    const message = injectVariables(messageTemplate, ctx);

    return sendTelegramRawMessage(token, cfg.chatId, message);
  },
};

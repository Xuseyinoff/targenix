import { eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import { decrypt } from "../../encryption";
import { injectVariables, type LeadPayload } from "../../services/affiliateService";
import { sendTelegramRawMessage } from "../../services/telegramService";
import type { DbClient } from "../../db";
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
  /** Step 3 hybrid mode — when provided, credentials are resolved from connections.credentialsJson first. */
  db?: DbClient;
  userId?: number;
  connectionId?: number | null;
}

type ResolvedTelegramCredentials = {
  botTokenEncrypted: string;
  chatId: string;
  source: "connection" | "templateConfig";
};

/**
 * Try the unified connections table first. On any failure (missing row, owner
 * mismatch, wrong type, inactive status, malformed credentialsJson, DB error)
 * return null so the caller can fall back to templateConfig.
 *
 * Never throws — delivery must remain robust while Step 3 rolls out.
 */
async function tryResolveFromConnection(
  db: DbClient | undefined,
  userId: number | undefined,
  connectionId: number | null | undefined,
): Promise<ResolvedTelegramCredentials | null> {
  if (!db || !connectionId || typeof userId !== "number") return null;

  try {
    const [row] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    if (!row) return null;
    if (row.userId !== userId) {
      console.warn(
        `[telegramAdapter] connection ${connectionId} owner mismatch (userId=${row.userId}, expected=${userId}); falling back`,
      );
      return null;
    }
    if (row.type !== "telegram_bot") {
      console.warn(
        `[telegramAdapter] connection ${connectionId} type='${row.type}' (expected 'telegram_bot'); falling back`,
      );
      return null;
    }
    if (row.status !== "active") {
      console.warn(
        `[telegramAdapter] connection ${connectionId} status='${row.status}' (expected 'active'); falling back`,
      );
      return null;
    }

    const creds = (row.credentialsJson ?? {}) as Record<string, unknown>;
    const botTokenEncrypted = typeof creds.botTokenEncrypted === "string" ? creds.botTokenEncrypted : null;
    const chatId = typeof creds.chatId === "string" ? creds.chatId : null;
    if (!botTokenEncrypted || !chatId) return null;

    return { botTokenEncrypted, chatId, source: "connection" };
  } catch (err) {
    console.warn(
      `[telegramAdapter] connection ${connectionId} load failed; falling back to templateConfig:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export const telegramAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const opts = config as TelegramAdapterConfig;
    const { templateConfig: cfg, leadRow } = opts;

    const fromConn = await tryResolveFromConnection(opts.db, opts.userId, opts.connectionId);

    const botTokenEncrypted = fromConn?.botTokenEncrypted ?? cfg.botTokenEncrypted;
    const chatId = fromConn?.chatId ?? cfg.chatId;

    if (!botTokenEncrypted || !chatId) {
      return {
        success: false,
        error: "Telegram destination missing botToken or chatId",
        errorType: "validation",
      };
    }

    let token: string;
    try {
      token = decrypt(botTokenEncrypted);
    } catch (err) {
      return {
        success: false,
        error: `Failed to decrypt Telegram bot token: ${err instanceof Error ? err.message : String(err)}`,
        errorType: "validation",
      };
    }

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

    return sendTelegramRawMessage(token, chatId, message);
  },
};

import type { Connection, targetWebsites } from "../../../drizzle/schema";
import { sendLeadViaTemplate, type LeadPayload } from "../../services/affiliateService";
import type { DbClient } from "../../db";
import type { DeliveryResult } from "../types";
import { loadDynamicExecutionTemplate } from "../dynamicTemplateSource";

interface DynamicTemplateAdapterConfig {
  db: DbClient;
  /** Full row preferred — needs `actionId` for Stage 2 `app_actions` path. */
  targetWebsite: Pick<
    typeof targetWebsites.$inferSelect,
    "id" | "templateId" | "templateConfig" | "actionId" | "appKey"
  >;
  variableFields: Record<string, string>;
  /**
   * Stage 2 — linked connection row (if any). When active and
   * populated, its `credentialsJson.secretsEncrypted` map is passed
   * through to `sendLeadViaTemplate` as the secrets source. Omitting
   * it preserves legacy behaviour (reads `templateConfig.secrets`).
   */
  connection?: Connection | null;
  /**
   * Stage 3 — tenant id of the destination's owner, threaded so the
   * `USE_CONNECTION_SECRETS_ONLY` feature flag can be evaluated
   * per-user inside `resolveSecretsForDelivery`.
   */
  userId?: number | null;
}

/**
 * Lead delivery for admin/affiliate HTTP templates only.
 * Telegram / Google Sheets are routed in `resolveAdapterKey` to their dedicated
 * adapters (see `dispatchDelivery`) — this module is never used when `appKey`
 * (or legacy `templateType`) is `telegram` / `google-sheets`.
 */
export const dynamicTemplateAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { db, targetWebsite, variableFields, connection, userId } =
      config as DynamicTemplateAdapterConfig;

    const loaded = await loadDynamicExecutionTemplate(
      db,
      targetWebsite as typeof targetWebsites.$inferSelect,
    );
    if (!loaded) {
      return {
        success: false,
        error: `Template ${targetWebsite.templateId} not found`,
        errorType: "validation",
      };
    }

    return sendLeadViaTemplate(
      loaded.template,
      targetWebsite.templateConfig,
      lead,
      variableFields,
      connection ?? null,
      userId ?? null,
      db,
    );
  },
};

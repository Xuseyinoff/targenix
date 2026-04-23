import {
  sendAffiliateOrderByTemplate,
  type TemplateType,
  type TemplateConfig,
  type LeadPayload,
} from "../../services/affiliateService";
import type { Connection } from "../../../drizzle/schema";
import type { DeliveryAdapter, DeliveryResult } from "../types";

interface LegacyTemplateConfig {
  templateType: TemplateType;
  templateConfig: TemplateConfig;
  variableFields: Record<string, string>;
  url: string | null | undefined;
  /**
   * Stage 2 — linked connection row (if any). When active and
   * populated, its `credentialsJson.secretsEncrypted` becomes the
   * authoritative source for `{{SECRET:key}}` tokens. Legacy
   * destinations without a connection pass `null` / `undefined`, in
   * which case `sendAffiliateOrderByTemplate` falls back to
   * `templateConfig.secrets` exactly as before.
   */
  connection?: Connection | null;
}

export const legacyTemplateAdapter: DeliveryAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { templateType, templateConfig, variableFields, url, connection } =
      config as LegacyTemplateConfig;
    return sendAffiliateOrderByTemplate(
      templateType,
      templateConfig,
      lead,
      variableFields,
      url ?? "",
      connection ?? null,
    );
  },
};

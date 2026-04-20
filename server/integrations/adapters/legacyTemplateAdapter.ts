import {
  sendAffiliateOrderByTemplate,
  type TemplateType,
  type TemplateConfig,
  type LeadPayload,
} from "../../services/affiliateService";
import type { DeliveryAdapter, DeliveryResult } from "../types";

interface LegacyTemplateConfig {
  templateType: TemplateType;
  templateConfig: TemplateConfig;
  variableFields: Record<string, string>;
  url: string | null | undefined;
}

export const legacyTemplateAdapter: DeliveryAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { templateType, templateConfig, variableFields, url } = config as LegacyTemplateConfig;
    return sendAffiliateOrderByTemplate(
      templateType,
      templateConfig,
      lead,
      variableFields,
      url ?? "",
    );
  },
};

import { eq } from "drizzle-orm";
import { destinationTemplates } from "../../../drizzle/schema";
import { sendLeadViaTemplate, type LeadPayload } from "../../services/affiliateService";
import type { DbClient } from "../../db";
import type { DeliveryResult } from "../types";

interface DynamicTemplateAdapterConfig {
  db: DbClient;
  targetWebsite: { templateId: number; templateConfig: unknown };
  variableFields: Record<string, string>;
}

export const dynamicTemplateAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { db, targetWebsite, variableFields } = config as DynamicTemplateAdapterConfig;

    const [dynTpl] = await db
      .select()
      .from(destinationTemplates)
      .where(eq(destinationTemplates.id, targetWebsite.templateId))
      .limit(1);

    if (!dynTpl) {
      return {
        success: false,
        error: `Template ${targetWebsite.templateId} not found`,
        errorType: "validation",
      };
    }

    return sendLeadViaTemplate(dynTpl, targetWebsite.templateConfig, lead, variableFields);
  },
};

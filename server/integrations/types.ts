import type { DeliveryErrorType } from "../lib/orderRetryPolicy";
import type { LeadPayload } from "../services/affiliateService";
import type { DbClient } from "../db";
import type { leads, targetWebsites, destinationTemplates } from "../../drizzle/schema";

export type DeliveryResult = {
  success: boolean;
  responseData?: unknown;
  error?: string;
  errorType?: DeliveryErrorType;
  durationMs?: number;
};

export interface DeliveryAdapter {
  send(config: unknown, lead: LeadPayload): Promise<DeliveryResult>;
}

export interface DeliveryContext {
  db: DbClient;
  userId: number;
  lead?: typeof leads.$inferSelect;
  targetWebsite?: typeof targetWebsites.$inferSelect;
  destinationTemplate?: typeof destinationTemplates.$inferSelect;
  variableFields?: Record<string, string>;
}

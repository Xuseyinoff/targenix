import type { DeliveryErrorType } from "../lib/orderRetryPolicy";
import type { LeadPayload } from "../services/affiliateService";
import type { DbClient } from "../db";
import type { leads, destinations, destinationTemplates } from "../../drizzle/schema";

export type DeliveryResult = {
  success: boolean;
  responseData?: unknown;
  error?: string;
  errorType?: DeliveryErrorType;
  durationMs?: number;
  /**
   * Provider-suggested cooldown (in milliseconds) — typically derived from a
   * `Retry-After` or `X-RateLimit-Reset` header on a 429 response. When
   * present, `computeNextRetryAt` will prefer this over the policy ladder
   * so we honour the partner's explicit "wait N seconds" instruction
   * instead of guessing.
   */
  retryAfterMs?: number;
};

export interface DeliveryAdapter {
  send(config: unknown, lead: LeadPayload): Promise<DeliveryResult>;
}

export interface DeliveryContext {
  db: DbClient;
  userId: number;
  lead?: typeof leads.$inferSelect;
  targetWebsite?: typeof destinations.$inferSelect;
  destinationTemplate?: typeof destinationTemplates.$inferSelect;
  variableFields?: Record<string, string>;
}

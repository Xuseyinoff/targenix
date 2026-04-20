import type { DeliveryErrorType } from "../lib/orderRetryPolicy";
import type { LeadPayload } from "../services/affiliateService";

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

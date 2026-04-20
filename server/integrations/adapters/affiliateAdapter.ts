import { sendAffiliateOrder, type AffiliateConfig, type LeadPayload } from "../../services/affiliateService";
import type { DeliveryAdapter, DeliveryResult } from "../types";

export const affiliateAdapter: DeliveryAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    return sendAffiliateOrder(config as AffiliateConfig, lead);
  },
};

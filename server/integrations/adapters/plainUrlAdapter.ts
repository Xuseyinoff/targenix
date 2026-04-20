import { assertSafeOutboundUrl } from "../../lib/urlSafety";
import { inferDeliveryErrorType } from "../../lib/orderRetryPolicy";
import type { LeadPayload } from "../../services/affiliateService";
import type { DeliveryAdapter, DeliveryResult } from "../types";

export const plainUrlAdapter: DeliveryAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const { targetUrl, targetHeaders, flow, offerId } = config as {
      targetUrl?: string;
      targetHeaders?: Record<string, string>;
      flow?: string;
      offerId?: string;
    };

    if (!targetUrl) {
      return { success: false, error: "No targetUrl configured in LEAD_ROUTING integration", errorType: "validation" };
    }

    try {
      await assertSafeOutboundUrl(targetUrl);
    } catch (err) {
      return {
        success: false,
        error: `Invalid targetUrl: ${err instanceof Error ? err.message : String(err)}`,
        errorType: "validation",
      };
    }

    try {
      const body = {
        ...(lead.extraFields ?? {}),
        name: lead.fullName,
        phone: lead.phone,
        email: lead.email,
        flow: flow ?? "",
        offer_id: offerId ?? "",
        leadgen_id: lead.leadgenId,
        page_id: lead.pageId,
        form_id: lead.formId,
      };

      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(targetHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      const text = await res.text();
      let responseData: unknown;
      try { responseData = JSON.parse(text); } catch { responseData = text; }

      if (!res.ok) {
        const errMsg = `HTTP ${res.status}`;
        return {
          success: false,
          error: errMsg,
          responseData,
          errorType: inferDeliveryErrorType({ httpStatus: res.status, message: errMsg }),
        };
      }
      return { success: true, responseData };
    } catch (err) {
      const msg = String(err);
      return { success: false, error: msg, errorType: inferDeliveryErrorType({ message: msg }) ?? "network" };
    }
  },
};

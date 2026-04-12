/**
 * Lead pipeline badge model — labels and semantics only (no Tailwind).
 *
 * UX (3 layers):
 * 1) Data (Graph): until ENRICHED we show **Fetching data**; on failure **Data Error** — never "Delivered".
 * 2) Delivery (lead): after data is OK, routing outcomes — **Delivered** / **Partially Delivered** /
 *    **Delivery Failed** / **Processing** / **Awaiting delivery**.
 * 3) Order (integration): separate UI — **Sent** / **Failed** / **Pending** (lighter badge under lead).
 *
 * "Delivered" MUST mean `deliveryStatus === SUCCESS` only, not Graph success.
 */

export type LeadPipelineFields = {
  dataStatus: string;
  deliveryStatus: string;
};

/** Semantic key for icon + analytics */
export type LeadBadgeKey =
  | "DATA_ERROR"
  | "DELIVERED"
  | "PARTIALLY_DELIVERED"
  | "DELIVERY_FAILED"
  | "PROCESSING"
  | "AWAITING_DELIVERY"
  | "FETCHING_DATA"
  | "PENDING";

export type LeadBadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

export type LeadBadgeConfig = {
  key: LeadBadgeKey;
  label: string;
  tone: LeadBadgeTone;
  /** Short hint for title/tooltip (optional) */
  description: string;
};

export function leadIsRetryable(lead: LeadPipelineFields): boolean {
  return (
    lead.dataStatus === "ERROR" ||
    lead.deliveryStatus === "FAILED" ||
    lead.deliveryStatus === "PARTIAL"
  );
}

/**
 * Lead-level badge: Graph state first; otherwise delivery-only labels.
 */
export function getLeadPipelineBadgeConfig(lead: LeadPipelineFields): LeadBadgeConfig {
  if (lead.dataStatus === "ERROR") {
    return {
      key: "DATA_ERROR",
      label: "Data Error",
      tone: "danger",
      description: "Facebook Graph or token failed — lead was not routed.",
    };
  }

  switch (lead.deliveryStatus) {
    case "SUCCESS":
      return {
        key: "DELIVERED",
        label: "Delivered",
        tone: "success",
        description: "All integrations accepted this lead.",
      };
    case "PARTIAL":
      return {
        key: "PARTIALLY_DELIVERED",
        label: "Partially Delivered",
        tone: "warning",
        description: "Some integrations succeeded, others failed.",
      };
    case "FAILED":
      return {
        key: "DELIVERY_FAILED",
        label: "Delivery Failed",
        tone: "danger",
        description: "Every integration attempt failed.",
      };
    case "PROCESSING":
      return {
        key: "PROCESSING",
        label: "Processing",
        tone: "info",
        description: "Routing to integrations in progress.",
      };
    default:
      if (lead.dataStatus === "PENDING") {
        return {
          key: "FETCHING_DATA",
          label: "Fetching data",
          tone: "warning",
          description: "Waiting for Facebook Graph enrichment.",
        };
      }
      if (lead.dataStatus === "ENRICHED") {
        return {
          key: "AWAITING_DELIVERY",
          label: "Awaiting delivery",
          tone: "neutral",
          description: "Data ready — routing not started or queued.",
        };
      }
      return {
        key: "PENDING",
        label: "Pending",
        tone: "neutral",
        description: "Lead is being processed.",
      };
  }
}

export type OrderBadgeKey = "sent" | "failed" | "pending" | "unknown";

export type OrderBadgeConfig = {
  key: OrderBadgeKey;
  label: string;
  tone: "success" | "danger" | "warning" | "neutral";
};

/** Integration row — human-readable, Title Case (not ALL CAPS). */
export function getOrderBadgeConfig(status: string): OrderBadgeConfig {
  const s = String(status).toUpperCase();
  if (s === "SENT") {
    return { key: "sent", label: "Sent", tone: "success" };
  }
  if (s === "FAILED") {
    return { key: "failed", label: "Failed", tone: "danger" };
  }
  if (s === "PENDING") {
    return { key: "pending", label: "Pending", tone: "warning" };
  }
  return { key: "unknown", label: status, tone: "neutral" };
}

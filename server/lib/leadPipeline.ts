/**
 * Lead pipeline — delivery aggregation (integration outcomes → lead.deliveryStatus).
 */

export type OrderDeliveryOutcome = "SENT" | "FAILED";

/**
 * From one processLead routing pass: no integrations → SUCCESS (nothing to deliver).
 * All SENT → SUCCESS; all FAILED → FAILED; mix → PARTIAL.
 */
export function aggregateDeliveryStatus(outcomes: OrderDeliveryOutcome[]): "SUCCESS" | "FAILED" | "PARTIAL" {
  if (outcomes.length === 0) return "SUCCESS";
  const sent = outcomes.filter((o) => o === "SENT").length;
  const failed = outcomes.filter((o) => o === "FAILED").length;
  if (sent === outcomes.length) return "SUCCESS";
  if (failed === outcomes.length) return "FAILED";
  return "PARTIAL";
}

export type OrderRowStatus = "PENDING" | "SENT" | "FAILED";

/**
 * Aggregate persisted order rows → lead.deliveryStatus.
 * Any PENDING row means routing is still in flight (PROCESSING).
 */
export function aggregateLeadDeliveryFromOrderStatuses(
  statuses: OrderRowStatus[],
): "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "PARTIAL" {
  if (statuses.length === 0) return "SUCCESS";
  const pending = statuses.filter((s) => s === "PENDING").length;
  const sent = statuses.filter((s) => s === "SENT").length;
  const failed = statuses.filter((s) => s === "FAILED").length;
  if (pending > 0) return "PROCESSING";
  if (sent === statuses.length) return "SUCCESS";
  if (failed === statuses.length) return "FAILED";
  return "PARTIAL";
}

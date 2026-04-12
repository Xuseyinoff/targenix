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

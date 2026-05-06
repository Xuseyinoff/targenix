/**
 * CRM order status tiers shared between sync worker and UI.
 *
 * FINAL   — terminal states; order will not change again (skip sync)
 * MID     — semi-stable; may still move, but infrequently
 * ACTIVE  — in-flight; poll frequently
 */

export const FINAL_STATUSES = new Set([
  "delivered",
  "not_delivered",
  "cancelled",
  "client_returned",
  "trash",
  "not_sold",
  "not_sold_group",
  "archived",
]);

export const MID_STATUSES = new Set([
  "sent",
  "booked",
  "preparing",
  "recycling",
  "on_argue",
]);

export const ACTIVE_STATUSES = new Set([
  "new",
  "accepted",
  "filling",
  "callback",
]);

export function classifyStatus(status: string | null | undefined): "FINAL" | "MID" | "ACTIVE" {
  if (!status) return "ACTIVE";
  if (FINAL_STATUSES.has(status)) return "FINAL";
  if (MID_STATUSES.has(status)) return "MID";
  return "ACTIVE";
}

export function isFinalStatus(status: string | null | undefined): boolean {
  return !!status && FINAL_STATUSES.has(status);
}

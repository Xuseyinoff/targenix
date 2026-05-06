/**
 * CRM order status tiers + Sotuvchi / 100k → normalized “universal” status.
 *
 * Two layers persisted on orders:
 *   crmRawStatus — platformdan kelgan exact string (Sotuvchi ~18+ variant)
 *   crmStatus    — analytics uchun soddalashtirilgan canonical status (~10 values)
 */

/** Canonical normalized statuses written to orders.crmStatus (lowercase snake). */
export type CrmNormalizedStatus =
  | "new"
  | "contacted"
  | "in_progress"
  | "success"
  | "delivered"
  | "cancelled"
  | "returned"
  | "not_delivered"
  | "trash"
  | "not_sold"
  | "archived"
  | "unknown";

/**
 * Canonical set for filters / dashboards (analytics). Legacy CRM strings may still appear
 * on old rows until re-sync; badges can map those via a separate lookup.
 */
export const CANONICAL_CRM_STATUS_ORDER = [
  "new",
  "contacted",
  "in_progress",
  "unknown",
  "success",
  "delivered",
  "cancelled",
  "returned",
  "not_delivered",
  "trash",
  "not_sold",
  "archived",
] as const satisfies readonly CrmNormalizedStatus[];

/** Sotuvchi API raw → normalized (analytics / funnel). */
export function mapSotuvchiRawToNormalized(raw: string): CrmNormalizedStatus | string {
  const k = raw.trim().toLowerCase();
  switch (k) {
    case "request":
    case "new":
      return "new";
    case "accepted":
    case "filling":
    case "order":
      return "contacted";
    case "sent":
    case "booked":
    case "preparing":
    case "recycling":
    case "on_argue":
    case "callback":
      return "in_progress";
    case "sold":
      return "success";
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "product_out_of_stock":
      return "not_sold";
    case "client_returned":
      return "returned";
    case "not_delivered":
      return "not_delivered";
    case "trash":
      return "trash";
    case "not_sold":
    case "not_sold_group":
      return "not_sold";
    case "archived":
      return "archived";
    default:
      return k ? "unknown" : "new";
  }
}

/** 100k.uz raw → normalized (same canonical set). */
export function mapHundredKRawToNormalized(raw: string): CrmNormalizedStatus | string {
  const k = raw.trim().toLowerCase();
  switch (k) {
    case "new":
    case "request":
      return "new";
    case "accepted":
    case "filling":
    case "order":
      return "contacted";
    case "sent":
    case "booked":
    case "preparing":
    case "callback":
      return "in_progress";
    case "sold":
      return "success";
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "product_out_of_stock":
      return "not_sold";
    case "client_returned":
      return "returned";
    case "not_delivered":
      return "not_delivered";
    case "trash":
      return "trash";
    case "not_sold":
    case "not_sold_group":
      return "not_sold";
    case "archived":
      return "archived";
    default:
      return k ? "unknown" : "new";
  }
}

/**
 * FINAL — terminal; sync skips these rows once is_final is set.
 * Only normalized values (no legacy aliases); old rows re-sync to canonical crmStatus.
 *
 * Note: some CRMs use `archived` as “hidden in UI” only; if you need rare re-validation,
 * add a separate slow job (e.g. 24h) — not enabled here.
 */
export const FINAL_STATUSES = new Set<string>([
  "delivered",
  "cancelled",
  "returned",
  "not_delivered",
  "trash",
  "not_sold",
  "archived",
]);

/**
 * MID — may still flip to delivered/etc.; poll slower than ACTIVE.
 * Includes legacy status strings still on rows.
 */
export const MID_STATUSES = new Set<string>([
  "in_progress",
  "success",
  "unknown",
  "sent",
  "booked",
  "preparing",
  "recycling",
  "on_argue",
]);

/**
 * ACTIVE — high-churn funnel top; poll more often.
 * Legacy: accepted, filling, callback matched old normalization.
 */
export const ACTIVE_STATUSES = new Set<string>([
  "new",
  "contacted",
  "accepted",
  "filling",
  "callback",
]);

export function classifyStatus(status: string | null | undefined): "FINAL" | "MID" | "ACTIVE" {
  if (!status) return "ACTIVE";
  if (FINAL_STATUSES.has(status)) return "FINAL";
  if (MID_STATUSES.has(status)) return "MID";
  if (ACTIVE_STATUSES.has(status)) return "ACTIVE";
  /* Old crm_status strings not yet re-mapped — poll as MID */
  return "MID";
}

export function isFinalStatus(status: string | null | undefined): boolean {
  return !!status && FINAL_STATUSES.has(status);
}

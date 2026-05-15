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
  | "sent"
  | "callback"
  | "success"
  | "delivered"
  | "cancelled"
  | "returned"
  | "not_delivered"
  | "out_of_stock"
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
  "sent",
  "callback",
  "unknown",
  "success",
  "delivered",
  "cancelled",
  "returned",
  "not_delivered",
  "out_of_stock",
  "trash",
  "not_sold",
  "archived",
] as const satisfies readonly CrmNormalizedStatus[];

/**
 * Sotuvchi API raw → normalized (analytics / funnel).
 *
 * Verified 2026-05-15 against live API (samanhusanov11 webmaster account):
 *   request                → new          (UI: "Yangi")
 *   order                  → contacted    (UI: "Qabul qilindi")
 *   preparing              → in_progress  (UI: "Tayyorlanmoqda")
 *   sent                   → sent         (UI: "Yuborildi")
 *   recycling              → callback     (UI: "Qayta qo'ng'iroq")
 *   not_delivered          → retry        (UI: "Qayta ishlash" — NOT terminal!)
 *   sold                   → success      (UI: "Sotildi")
 *   delivered              → delivered    (UI: "Yetkazildi", terminal)
 *   cancelled              → cancelled    (UI: "Bekor qilindi", terminal)
 *   product_out_of_stock   → out_of_stock (UI: "Mahsulot yetmadi")
 *   trash                  → trash        (UI: "Trash", terminal)
 *
 * Legacy codes (accepted, filling, booked, callback, on_argue, client_returned,
 * not_sold, not_sold_group, archived) kept for backward compatibility with
 * historical DB rows — Sotuvchi v3 API no longer emits them.
 */
export function mapSotuvchiRawToNormalized(raw: string): CrmNormalizedStatus | string {
  const k = raw.trim().toLowerCase();
  switch (k) {
    case "request":
    case "new":
      return "new";
    case "order":
    case "accepted":
    case "filling":
      return "contacted";
    case "preparing":
    case "booked":
      return "in_progress";
    case "sent":
      return "sent";
    case "recycling":
    case "callback":
    case "on_argue":
      return "callback";
    case "not_delivered":
      return "not_delivered";
    case "sold":
      return "success";
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "product_out_of_stock":
      return "out_of_stock";
    case "client_returned":
      return "returned";
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
    case "booked":
    case "preparing":
      return "in_progress";
    case "sent":
      return "sent";
    case "callback":
      return "callback";
    case "sold":
      return "success";
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "product_out_of_stock":
      return "out_of_stock";
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
 * Note: some CRMs use `archived` as "hidden in UI" only; if you need rare re-validation,
 * add a separate slow job (e.g. 24h) — not enabled here.
 *
 * `not_delivered` is NOT here: verified 2026-05-15 that Sotuvchi labels it
 * "Qayta ishlash" (retry) and orders routinely transition from not_delivered
 * back to sent/delivered. Treating it as terminal would freeze orders mid-flight.
 */
export const FINAL_STATUSES = new Set<string>([
  "delivered",
  "cancelled",
  "returned",
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
  "sent",
  "callback",
  "success",
  "not_delivered",
  "out_of_stock",
  "unknown",
  "booked",
  "preparing",
  "recycling",
  "on_argue",
]);

/**
 * ACTIVE — high-churn funnel top; poll more often.
 * Legacy: accepted, filling matched old normalization.
 */
export const ACTIVE_STATUSES = new Set<string>([
  "new",
  "contacted",
  "accepted",
  "filling",
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

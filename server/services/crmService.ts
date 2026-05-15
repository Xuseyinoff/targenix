import axios from "axios";
import {
  mapHundredKRawToNormalized,
  mapSotuvchiRawToNormalized,
} from "../../shared/crmStatuses";
import { extractExternalOrderId } from "../../shared/extractExternalOrderId";

export { extractExternalOrderId };

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LoginResult {
  bearerToken: string;
  platformUserId: string;
}

export interface OrderStatusResult {
  externalId: string;
  status: string;
  rawStatus: string;
  /** Payout amount in the SMALLEST unit of `payoutCurrency`. Captured when
   *  the platform's status response includes it (sotuvchi → order.pay_for,
   *  integer UZS so'm). null when the platform doesn't expose it or the
   *  order isn't in a payout-eligible state. */
  payoutAmount?: number | null;
  /** ISO-4217 currency of payoutAmount. 'UZS' for sotuvchi; null when
   *  payoutAmount is null. */
  payoutCurrency?: string | null;
}

export interface OrderPageItem {
  id: number;
  status: string;
  created_at: string;
  /** Per-order payout in the platform's currency (sotuvchi: integer UZS
   *  so'm from `pay_for`). Captured directly from /getOrders so the
   *  pagination sync can populate Pipeline / Revenue without a
   *  separate per-order /getOrderDetails call. Null when the row didn't
   *  surface it. */
  payoutAmount?: number | null;
  payoutCurrency?: string | null;
  /** Sotuvchi's internal offer id (`offer_id`). Useful for label
   *  resolution when our local `orders.offerId` snapshot is missing
   *  (e.g. legacy orders that pre-date the offer-capture wire-up). */
  offerId?: string | null;
  /** Human-readable offer name (`offer.name` on sotuvchi's response).
   *  Captured so the Insights UI can render real names instead of raw
   *  numeric ids in the offer breakdown. */
  offerName?: string | null;
}

export interface OrderPageResult {
  data: OrderPageItem[];
  current_page: number;
  last_page: number;
  total: number;
}

/** Sotuvchi raw API string → orders.crmStatus (canonical). */
export function normalizeSotuvchiStatus(raw: string): string {
  return mapSotuvchiRawToNormalized(raw);
}

// ─── Sotuvchi Adapter ─────────────────────────────────────────────────────────
const SOTUVCHI_BASE = "https://apiv3.sotuvchi.com/api";

/** Platform headers documented for apiv3 (Accept-Language required for predictable messages). */
const sotuvchiHeaders = {
  Accept: "application/json",
  "Accept-Language": "uz",
} as const;

async function sotuvchiLogin(phone: string, password: string): Promise<LoginResult> {
  // Field `phone` in CRM UI holds Sotuvchi **email** (see AdminCrmAccounts).
  const res = await axios.post(
    `${SOTUVCHI_BASE}/login`,
    { email: phone.trim(), password },
    { timeout: 10_000, headers: { "Content-Type": "application/json", ...sotuvchiHeaders } },
  );

  const d = res.data?.data;
  const token: string =
    res.data?.token ??
    res.data?.access_token ??
    (typeof d === "string" ? d : undefined) ??
    (d && typeof d === "object" ? (d as { token?: string }).token : undefined) ??
    (d && typeof d === "object"
      ? (d as { access_token?: string }).access_token
      : undefined);
  if (!token) throw new Error("Sotuvchi login: token topilmadi");

  const meRes = await axios.get(`${SOTUVCHI_BASE}/info`, {
    headers: { Authorization: `Bearer ${token}`, ...sotuvchiHeaders },
    timeout: 10_000,
  });

  // Response shape: { "user": { "id": 1, ... } }
  const me = meRes.data?.user ?? meRes.data?.data ?? meRes.data;
  const userId = String(
    (me && typeof me === "object" ? (me as { id?: unknown }).id : undefined) ??
      meRes.data?.user_id ??
      meRes.data?.id ??
      "",
  );
  if (!userId) throw new Error("Sotuvchi login: userId topilmadi");

  return { bearerToken: token, platformUserId: userId };
}

async function sotuvchiGetOrderStatus(
  bearerToken: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const res = await axios.get(`${SOTUVCHI_BASE}/getOrderDetails`, {
    params: { id: orderId },
    headers: { Authorization: `Bearer ${bearerToken}`, ...sotuvchiHeaders },
    timeout: 10_000,
  });

  const order = res.data?.order ?? res.data?.data ?? res.data ?? {};
  const raw: string = order?.status ?? "";

  // pay_for is sotuvchi's per-order payout in UZS so'm (verified via probe
  // tooling/probe-sotuvchi-payout.ts on 2026-05-15). Integer on the wire —
  // UZS has no fractional subunit in practice. Null/missing for non-payable
  // states (cancelled, trash, etc.); we capture whatever the platform
  // reports and let the rollup filter by delivered status downstream.
  const payRaw = order?.pay_for;
  const payNum = typeof payRaw === "number" ? payRaw : parseInt(String(payRaw ?? ""), 10);
  const payoutAmount = Number.isFinite(payNum) && payNum > 0 ? Math.round(payNum) : null;

  return {
    externalId: orderId,
    status: mapSotuvchiRawToNormalized(raw),
    rawStatus: raw,
    payoutAmount,
    payoutCurrency: payoutAmount !== null ? "UZS" : null,
  };
}

export async function sotuvchiGetOrdersPage(
  bearerToken: string,
  page: number,
  limit: number,
): Promise<OrderPageResult> {
  const res = await axios.get(`${SOTUVCHI_BASE}/getOrders`, {
    params: { page, limit },
    headers: { Authorization: `Bearer ${bearerToken}`, ...sotuvchiHeaders },
    timeout: 15_000,
  });
  const o = res.data?.orders;
  return {
    data: (o?.data ?? []).map((item: Record<string, unknown>) => {
      // pay_for arrives as a JSON number (probe 2026-05-15). UZS has no
      // fractional subunit in practice, so we just round and clamp.
      const rawPay = item.pay_for;
      const payNum = typeof rawPay === "number" ? rawPay : parseInt(String(rawPay ?? ""), 10);
      const payoutAmount = Number.isFinite(payNum) && payNum > 0 ? Math.round(payNum) : null;
      const offerId = item.offer_id != null ? String(item.offer_id) : null;
      // `offer.name` is nested under the `offer` object on the /getOrders
      // response (probe 2026-05-15). Truncate to the column width so a
      // long custom name can't break the UPDATE.
      const offerObj = item.offer as { name?: unknown } | undefined;
      const offerNameRaw = offerObj?.name;
      const offerName = typeof offerNameRaw === "string" && offerNameRaw.trim() !== ""
        ? offerNameRaw.slice(0, 255)
        : null;
      return {
        id: Number(item.id),
        status: String(item.status ?? ""),
        created_at: String(item.created_at ?? ""),
        payoutAmount,
        payoutCurrency: payoutAmount !== null ? "UZS" : null,
        offerId,
        offerName,
      };
    }),
    current_page: Number(o?.current_page ?? page),
    last_page: Number(o?.last_page ?? page),
    total: Number(o?.total ?? 0),
  };
}

// ─── 100k Adapter ───────────────────────────────────────────────────────────────
const HUNDREDK_BASE = "https://api.100k.uz/api";

async function hundredKLogin(phone: string, password: string): Promise<LoginResult> {
  const res = await axios.post(
    `${HUNDREDK_BASE}/auth/sign-in`,
    {
      username: phone,
      password,
      phone,
    },
    { timeout: 10_000 },
  );

  // Response: { message: "ok", data: "433376|TOKEN_STRING" }
  const tokenString: string = res.data?.data;
  if (!tokenString?.includes("|")) throw new Error("100k login: token formati noto'g'ri");

  const meRes = await axios.get(`${HUNDREDK_BASE}/users/getMe`, {
    headers: { Authorization: `Bearer ${tokenString}` },
    timeout: 10_000,
  });

  const userId = String(meRes.data?.data?.id ?? "");
  if (!userId) throw new Error("100k login: userId topilmadi");

  return { bearerToken: tokenString, platformUserId: userId };
}

async function hundredKGetOrderStatus(
  bearerToken: string,
  orderId: string,
  platformUserId: string,
): Promise<OrderStatusResult> {
  const res = await axios.get(`${HUNDREDK_BASE}/shop/v1/orders/${orderId}`, {
    params: { profile_id: platformUserId },
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    timeout: 10_000,
  });

  const raw: string =
    res.data?.data?.status ??
    res.data?.order?.status ??
    res.data?.status ??
    "";

  // 100k.uz response shape not yet probed for payout — Phase 3.1 once a
  // delivered 100k order is available to inspect. Returning null (rather
  // than omitting the field) keeps the downstream sync from confusing
  // "not yet checked" with "checked and absent" when destructuring.
  return {
    externalId: orderId,
    status: mapHundredKRawToNormalized(raw),
    rawStatus: raw,
    payoutAmount: null,
    payoutCurrency: null,
  };
}

/**
 * Bulk advertiser order list (admin.100k.uz parity).
 * Default `lead_source_grouped=in_progress` matches the web UI funnel bucket.
 *
 * The User-Agent below intentionally mimics admin.100k.uz's own dashboard
 * traffic — keeps our calls from standing out in their logs as a bot run.
 */
export async function hundredKGetAdvertiserOrdersPage(
  bearerToken: string,
  profileId: string,
  page: number,
  leadSourceGrouped = "in_progress",
): Promise<OrderPageResult> {
  const res = await axios.get(`${HUNDREDK_BASE}/users/${profileId}/advertiser-orders`, {
    params: {
      profile_id: profileId,
      page,
      lead_source_grouped: leadSourceGrouped,
    },
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://admin.100k.uz/",
      Origin: "https://admin.100k.uz",
    },
    timeout: 45_000,
  });

  const rows = res.data?.data ?? [];
  const meta = res.data?.meta ?? {};
  return {
    data: (rows as Record<string, unknown>[]).map((item) => ({
      id: Number(item.id),
      status: String(item.status ?? ""),
      created_at: String(item.created_at ?? ""),
    })),
    current_page: Number(meta.current_page ?? page),
    last_page: Number(meta.last_page ?? page),
    total: Number(meta.total ?? 0),
  };
}

// ─── Unified adapter interface ────────────────────────────────────────────────
export type Platform = "sotuvchi" | "100k";

export async function crmLogin(
  platform: Platform,
  phone: string,
  password: string,
): Promise<LoginResult> {
  if (platform === "sotuvchi") return sotuvchiLogin(phone, password);
  return hundredKLogin(phone, password);
}

export async function crmGetOrderStatus(
  platform: Platform,
  bearerToken: string,
  orderId: string,
  platformUserId: string,
): Promise<OrderStatusResult> {
  if (platform === "sotuvchi") return sotuvchiGetOrderStatus(bearerToken, orderId);
  return hundredKGetOrderStatus(bearerToken, orderId, platformUserId);
}


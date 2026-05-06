import axios from "axios";
import {
  mapHundredKRawToNormalized,
  mapSotuvchiRawToNormalized,
} from "../../shared/crmStatuses";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LoginResult {
  bearerToken: string;
  platformUserId: string;
}

export interface OrderStatusResult {
  externalId: string;
  status: string;
  rawStatus: string;
}

export interface OrderPageItem {
  id: number;
  status: string;
  created_at: string;
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

  const raw: string = res.data?.order?.status ?? res.data?.data?.status ?? res.data?.status ?? "";
  return {
    externalId: orderId,
    status: mapSotuvchiRawToNormalized(raw),
    rawStatus: raw,
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
    data: (o?.data ?? []).map((item: Record<string, unknown>) => ({
      id: Number(item.id),
      status: String(item.status ?? ""),
      created_at: String(item.created_at ?? ""),
    })),
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

  return {
    externalId: orderId,
    status: mapHundredKRawToNormalized(raw),
    rawStatus: raw,
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

/**
 * Extracts the external order ID from an order's responseData JSON.
 * Sotuvchi: { ok: "true", id: 694147 }
 * 100k.uz:  { data: { id: "abc" } } or { id: "abc" }
 */
export function extractExternalOrderId(responseData: unknown): string | null {
  if (!responseData || typeof responseData !== "object") return null;
  const d = responseData as Record<string, unknown>;
  const id = d.id ?? (d.data as Record<string, unknown> | undefined)?.id;
  return id != null ? String(id) : null;
}

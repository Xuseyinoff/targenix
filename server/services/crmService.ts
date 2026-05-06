import axios from "axios";

// ─── Status mapping ────────────────────────────────────────────────────────────
// Normalises platform-specific status strings to a single canonical set.
const SOTUVCHI_STATUS_MAP: Record<string, string> = {
  request: "new",
  new: "new",
  accepted: "accepted",
  order: "accepted",
  filling: "accepted",
  preparing: "booked",
  booked: "booked",
  sent: "sent",
  sold: "delivered",
  delivered: "delivered",
  not_delivered: "not_delivered",
  callback: "callback",
  recycling: "callback",
  on_argue: "callback",
  cancelled: "cancelled",
  canceled: "cancelled",
  trash: "cancelled",
  not_sold: "cancelled",
  not_sold_group: "cancelled",
  product_out_of_stock: "cancelled",
  client_returned: "cancelled",
  archived: "archived",
};

const HUNDREDK_STATUS_MAP: Record<string, string> = {
  new: "new",
  accepted: "accepted",
  booked: "booked",
  sent: "sent",
  delivered: "delivered",
  callback: "callback",
  cancelled: "cancelled",
  canceled: "cancelled",
  archived: "archived",
};

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
    status: SOTUVCHI_STATUS_MAP[raw.toLowerCase()] ?? raw,
    rawStatus: raw,
  };
}

// ─── 100k Adapter ─────────────────────────────────────────────────────────────
const HUNDREDK_BASE = "https://api.100k.uz/api";

async function hundredKLogin(phone: string, password: string): Promise<LoginResult> {
  const res = await axios.post(`${HUNDREDK_BASE}/auth/sign-in`, {
    username: phone,
    password,
    phone,
  }, { timeout: 10_000 });

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
    status: HUNDREDK_STATUS_MAP[raw.toLowerCase()] ?? raw,
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

/**
 * SQL match qilishni tekshirish — bizning DB orderdagi external_id-ni
 * 100k API javobidagi id bilan solishtirib, mos kelishini tasdiqlaydi.
 */

import "dotenv/config";
import axios from "axios";
import { sql, eq, and, isNotNull } from "drizzle-orm";
import { getDb } from "../server/db";
import { orders, targetWebsites, integrations } from "../drizzle/schema";

const BASE = "https://api.100k.uz/api";
const PHONE = "+998996006103";
const PASSWORD = "Samandar-2003";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Login
  const loginRes = await axios.post(
    `${BASE}/auth/sign-in`,
    { username: PHONE, phone: PHONE, password: PASSWORD },
    { timeout: 15_000 },
  );
  const token = loginRes.data?.data as string;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const meRes = await axios.get(`${BASE}/users/getMe`, { headers, timeout: 15_000 });
  const profileId = String(meRes.data?.data?.id ?? "");

  // Get one DB external id
  const [oneOrder] = await db
    .select({ orderId: orders.id, responseData: orders.responseData })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(targetWebsites.appKey, "100k"),
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
      ),
    )
    .limit(1);

  const r = oneOrder.responseData as Record<string, unknown>;
  const data = r?.data as Record<string, unknown> | undefined;
  const externalId = String(data?.order_id ?? data?.id ?? r?.id ?? "?");
  console.log(`DB orderId=${oneOrder.orderId}, externalId=${externalId}`);

  // Use the SAME externalIdExpr the sync uses, but querying for our specific external id
  const externalIdExpr = sql<string>`COALESCE(
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.order_id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.data.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.data.order_id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.data.data.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.order.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.order_id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.data.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.data.order_id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.data.data.id')), ''),
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.order.id')), '')
  )`;

  const matches = await db
    .select({
      orderId: orders.id,
      externalId: externalIdExpr,
    })
    .from(orders)
    .where(eq(orders.id, oneOrder.orderId));
  console.log("SQL externalIdExpr result:", matches);

  // Now hit the per-order endpoint to confirm the external id is real
  try {
    const res = await axios.get(`${BASE}/shop/v1/orders/${externalId}`, {
      params: { profile_id: profileId },
      headers,
      timeout: 15_000,
    });
    const d = res.data?.data ?? res.data;
    console.log(`100k API status for ${externalId}: status=${d?.status}, status_label=${d?.status_label}`);
  } catch (err) {
    const e = err as { response?: { status?: number; data?: unknown } };
    console.log(`100k API ERROR for ${externalId}: ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`);
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e?.message ?? e);
  process.exit(1);
});

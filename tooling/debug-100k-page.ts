/**
 * Bitta sahifani test qilish — pagination logikasi va match logikasini tekshiradi.
 */

import "dotenv/config";
import axios from "axios";
import { sql, eq, and, isNotNull } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  crmConnections,
  orders,
  targetWebsites,
  integrations,
} from "../drizzle/schema";
import { decrypt } from "../server/encryption";

const BASE = "https://api.100k.uz/api";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [acc] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.platform, "100k"))
    .limit(1);
  if (!acc) throw new Error("100k account topilmadi");

  const token = decrypt(acc.bearerTokenEncrypted);
  const profileId = acc.platformUserId!;
  console.log(`profileId=${profileId}`);

  // Try page 1000 directly — that should be near our orders' date range
  const targetPage = 1000;
  console.log(`\n=== Hitting page ${targetPage} directly ===`);
  const res = await axios.get(`${BASE}/users/${profileId}/advertiser-orders`, {
    params: { profile_id: profileId, page: targetPage, lead_source_grouped: "in_progress" },
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://admin.100k.uz/",
      Origin: "https://admin.100k.uz",
    },
    timeout: 30_000,
  });
  const data = (res.data?.data ?? []) as Array<Record<string, unknown>>;
  const meta = res.data?.meta ?? {};
  console.log(`  rows=${data.length}, total=${meta.total}, last_page=${meta.last_page}`);
  if (data.length > 0) {
    const first = data[0];
    const last = data[data.length - 1];
    console.log(`  first id=${first.id}, created_at=${first.created_at}, status=${first.status}`);
    console.log(`  last  id=${last.id}, created_at=${last.created_at}, status=${last.status}`);
  }

  // Sample IDs from this page
  const externalIds = data.map((o) => String(o.id));
  console.log(`  page ${targetPage} ids: ${externalIds.slice(0, 5).join(", ")}...`);

  // Now run the SAME match SQL the sync uses
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
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(targetWebsites.appKey, "100k"),
        eq(orders.isFinal, false),
        isNotNull(orders.responseData),
        sql`${externalIdExpr} IN (${sql.join(
          externalIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
  console.log(`\n  DB matches on this page: ${matches.length}`);
  for (const m of matches.slice(0, 10)) {
    console.log(`    DB orderId=${m.orderId}, externalId=${m.externalId}`);
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e?.message ?? e, e?.response?.data);
  process.exit(1);
});

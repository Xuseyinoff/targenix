/**
 * Migratsiyadan keyin yetim qolgan orderlarni tuzatish:
 *
 *   orders.destinationId = 0
 *   integrations.targetWebsiteId IS NULL
 *   integrations id integration_destinations qatorlarda mavjud
 *
 * Bu orderlar single-destination integrationdan fan-out'ga migrated bo'lganda
 * destinationId backfill qilinmagan. Endi har bir order'ni shu integration
 * uchun MAVJUD birinchi (eng qadimgi position) integration_destination'ga
 * bog'laymiz.
 *
 * Multi-destination'ga migratsiya bo'lgan integrationlar uchun esa biz
 * orderni faqat 1 ta destination'ga bog'laymiz (ambiguity bor, lekin u zamonda
 * faqat 1 destination ishlagan — birinchi yaratilgan, deb taxmin qilamiz).
 *
 *   pnpm exec tsx tooling/backfill-orders-destination-id.ts --dry-run    (default)
 *   pnpm exec tsx tooling/backfill-orders-destination-id.ts --apply      (DB yoziladi)
 */
import "dotenv/config";
import { sql, eq, and, isNull } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  orders,
  integrations,
  integrationDestinations,
} from "../drizzle/schema";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log(APPLY ? "MODE: APPLY (DB YOZILADI)" : "MODE: DRY-RUN (faqat ko'rsatish, DB tegmaydi)");

  // Birinchi (eng kichik id, ya'ni eng erta yaratilgan) integration_destinations
  // har integration uchun
  const firstDestSubq = sql`(
    SELECT MIN(id) AS firstId, integrationId
    FROM integration_destinations
    GROUP BY integrationId
  )`;

  // Yangilanadigan orderlar soni — drizzle/mysql execute [rows, fields] qaytaradi
  const countResult = (await db.execute(sql`
    SELECT COUNT(*) AS n
    FROM orders o
    INNER JOIN integrations i ON o.integrationId = i.id
    INNER JOIN ${firstDestSubq} AS fd ON fd.integrationId = i.id
    WHERE o.status = 'SENT'
      AND o.destinationId = 0
      AND i.targetWebsiteId IS NULL
  `)) as unknown as [Array<Record<string, unknown>>, unknown];
  const total = Number(countResult[0]?.[0]?.n ?? 0);
  console.log(`\nTuzatish kerak bo'lgan order soni: ${total}`);

  if (!APPLY) {
    const sampleResult = (await db.execute(sql`
      SELECT o.id AS orderId, o.integrationId, i.name AS integrationName, fd.firstId AS newDestinationId
      FROM orders o
      INNER JOIN integrations i ON o.integrationId = i.id
      INNER JOIN ${firstDestSubq} AS fd ON fd.integrationId = i.id
      WHERE o.status = 'SENT'
        AND o.destinationId = 0
        AND i.targetWebsiteId IS NULL
      ORDER BY o.id DESC
      LIMIT 10
    `)) as unknown as [Array<Record<string, unknown>>, unknown];
    console.log("\nNamuna (eng yangi 10 ta):");
    for (const r of sampleResult[0]) {
      console.log(`  orderId=${r.orderId}  integrationId=${r.integrationId}  name="${r.integrationName}"  destinationId: 0 → ${r.newDestinationId}`);
    }
    console.log("\n--apply bilan haqiqiy yangilanadi.");
    process.exit(0);
  }

  // Apply: bir SQL UPDATE — atomic
  console.log("\nYangilash boshlandi...");
  const startedAt = Date.now();
  const updateResult = await db.execute(sql`
    UPDATE orders o
    INNER JOIN integrations i ON o.integrationId = i.id
    INNER JOIN ${firstDestSubq} AS fd ON fd.integrationId = i.id
    SET o.destinationId = fd.firstId
    WHERE o.status = 'SENT'
      AND o.destinationId = 0
      AND i.targetWebsiteId IS NULL
  `);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Yakunlandi (${elapsed}s).`);
  console.log("Result:", updateResult);

  // Final sanity
  const [verifyRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        eq(orders.destinationId, 0),
        isNull(integrations.targetWebsiteId),
      ),
    );
  console.log(`Hali ham yashirin qolgan (qayta tekshiruv): ${verifyRow.n}`);

  process.exit(0);
}
void main().catch((e) => { console.error("xato:", e); process.exit(1); });

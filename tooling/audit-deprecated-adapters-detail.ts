/**
 * Detail follow-up audit: show every target_website + owner so we can be 100%
 * sure no row falls into the deprecated adapters.
 */
import "dotenv/config";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";
import { integrations, targetWebsites, users, orders } from "../drizzle/schema";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("=== ALL target_websites (with owner) ===\n");

  const rows = await db
    .select({
      id: targetWebsites.id,
      userId: targetWebsites.userId,
      name: targetWebsites.name,
      appKey: targetWebsites.appKey,
      templateType: targetWebsites.templateType,
      templateId: targetWebsites.templateId,
      url: targetWebsites.url,
      createdAt: targetWebsites.createdAt,
      userEmail: users.email,
      userName: users.name,
    })
    .from(targetWebsites)
    .leftJoin(users, eq(users.id, targetWebsites.userId))
    .orderBy(desc(targetWebsites.createdAt));

  for (const r of rows) {
    console.log(
      `tw#${String(r.id).padEnd(4)} u#${String(r.userId).padEnd(3)} appKey=${(r.appKey ?? "(null)").padEnd(15)} tplId=${String(r.templateId ?? "—").padEnd(4)} tplType=${(r.templateType ?? "—").padEnd(10)} owner=${(r.userEmail ?? r.userName ?? "?").padEnd(28)} "${r.name}"`,
    );
  }

  console.log("\n=== ALL integrations (all types) ===\n");
  const ints = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      type: integrations.type,
      name: integrations.name,
      isActive: integrations.isActive,
      userEmail: users.email,
    })
    .from(integrations)
    .leftJoin(users, eq(users.id, integrations.userId))
    .orderBy(desc(integrations.createdAt));
  console.log(`Total integrations: ${ints.length}`);
  const byType = ints.reduce<Record<string, number>>((m, r) => {
    m[r.type] = (m[r.type] ?? 0) + 1;
    return m;
  }, {});
  console.log("By type:", byType);
  for (const r of ints) {
    console.log(
      `int#${String(r.id).padEnd(5)} u#${String(r.userId).padEnd(3)} type=${r.type.padEnd(13)} active=${r.isActive ? "Y" : "N"} ${(r.userEmail ?? "?").padEnd(28)} "${r.name}"`,
    );
  }

  console.log("\n=== Recent orders by status (last 30d) ===");
  const last30 = await db
    .select({
      status: orders.status,
      n: sql<number>`COUNT(*)`,
    })
    .from(orders)
    .where(sql`${orders.createdAt} >= NOW() - INTERVAL 30 DAY`)
    .groupBy(orders.status);
  for (const r of last30) {
    console.log(`  ${r.status}: ${r.n}`);
  }

  await closeDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

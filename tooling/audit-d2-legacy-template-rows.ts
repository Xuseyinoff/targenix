/**
 * D2 audit: count target_websites rows that would still hit the legacy
 * test-integration branch in targetWebsitesRouter / integrationsRouter — i.e.
 * rows where templateId IS NULL AND templateType IN ('sotuvchi','100k','custom').
 *
 * If 0 on both local and prod, we can safely remove `sendAffiliateOrderByTemplate`
 * and the legacy custom test branch. If >0, we keep them for the editor's "Test"
 * button.
 */
import "dotenv/config";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";
import { targetWebsites, users } from "../drizzle/schema";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [countRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(targetWebsites)
    .where(
      and(
        isNull(targetWebsites.templateId),
        inArray(targetWebsites.templateType, ["sotuvchi", "100k", "custom"]),
      ),
    );

  const n = Number(countRow?.n ?? 0);
  console.log(`templateId IS NULL AND templateType IN ('sotuvchi','100k','custom'): ${n}`);

  if (n > 0) {
    const rows = await db
      .select({
        id: targetWebsites.id,
        userId: targetWebsites.userId,
        name: targetWebsites.name,
        appKey: targetWebsites.appKey,
        templateType: targetWebsites.templateType,
        userEmail: users.email,
      })
      .from(targetWebsites)
      .leftJoin(users, eq(users.id, targetWebsites.userId))
      .where(
        and(
          isNull(targetWebsites.templateId),
          inArray(targetWebsites.templateType, ["sotuvchi", "100k", "custom"]),
        ),
      )
      .orderBy(desc(targetWebsites.createdAt));
    console.log("\nMatching rows:");
    for (const r of rows) {
      console.log(
        `  tw#${r.id} u#${r.userId} appKey=${r.appKey} tplType=${r.templateType} owner=${r.userEmail ?? "?"} "${r.name}"`,
      );
    }
    console.log("\n⚠ KEEP sendAffiliateOrderByTemplate — these rows can still trigger the test path.");
  } else {
    console.log("\n✅ Zero rows — safe to fully remove sendAffiliateOrderByTemplate and TemplateType.");
  }

  await closeDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

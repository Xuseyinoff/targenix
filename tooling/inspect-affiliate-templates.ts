/**
 * destination_templates ichida affiliate (sotuvchi, 100k, alijahon, ...) qanday saqlangan
 */
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import { destinationTemplates } from "../drizzle/schema";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const rows = await db
    .select({
      id: destinationTemplates.id,
      appKey: destinationTemplates.appKey,
      name: destinationTemplates.name,
      userVisibleFields: destinationTemplates.userVisibleFields,
      variableFields: destinationTemplates.variableFields,
      autoMappedFields: destinationTemplates.autoMappedFields,
    })
    .from(destinationTemplates)
    .where(inArray(destinationTemplates.appKey, ["sotuvchi", "100k", "alijahon", "inbaza", "mgoods"]))
    .orderBy(destinationTemplates.appKey);
  console.log("affiliate destination_templates:");
  for (const r of rows) {
    console.log(`\nid=${r.id}  appKey=${r.appKey}  name=${r.name}`);
    console.log("  userVisibleFields:", JSON.stringify(r.userVisibleFields));
    console.log("  variableFields:", JSON.stringify(r.variableFields));
    console.log("  autoMappedFields:", JSON.stringify(r.autoMappedFields));
  }
  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });

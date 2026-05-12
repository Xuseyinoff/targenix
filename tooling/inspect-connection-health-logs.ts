/**
 * Inspect the production connection_health_logs table — schema + sample insert
 * to find why the WORKER is failing to write health log rows.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../server/db";
import { connectionHealthLogs } from "../drizzle/schema";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("=== SHOW CREATE TABLE connection_health_logs ===");
  const create = await db.execute(sql`SHOW CREATE TABLE connection_health_logs`);
  console.log(JSON.stringify((create as { rows?: unknown[] })[0] ?? create, null, 2));

  console.log("\n=== DESCRIBE connection_health_logs ===");
  const desc = await db.execute(sql`DESCRIBE connection_health_logs`);
  console.log(JSON.stringify(desc, null, 2));

  console.log("\n=== Most recent rows ===");
  const recent = await db
    .select()
    .from(connectionHealthLogs)
    .orderBy(sql`${connectionHealthLogs.checkedAt} DESC`)
    .limit(5);
  console.log(JSON.stringify(recent, null, 2));

  console.log("\n=== Attempt a dry-run insert (rolled back) ===");
  try {
    await db.transaction(async (tx) => {
      const res = await tx.insert(connectionHealthLogs).values({
        connectionId: 22,
        userId: 1,
        checkStatus: "ok",
        latencyMs: 0,
        errorMessage: null,
      });
      console.log("Insert result:", JSON.stringify(res));
      throw new Error("ROLLBACK");
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "ROLLBACK") {
      console.log("✅ Dry-run insert succeeded (rolled back)");
    } else {
      console.log("❌ Insert failed with error:");
      console.log(e instanceof Error ? e.stack : String(e));
    }
  }

  await closeDb();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

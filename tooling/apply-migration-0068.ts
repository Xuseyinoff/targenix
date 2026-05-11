import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";
import fs from "fs";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const migration = fs.readFileSync("drizzle/0068_integration_health_appkey.sql", "utf8");
  const stmts = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
  for (const stmt of stmts) {
    const clean = stmt.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    if (!clean) continue;
    console.log("Executing:", clean.slice(0, 80).replace(/\s+/g, " "), "...");
    await db.execute(sql.raw(clean));
  }
  const r = (await db.execute(sql`SHOW COLUMNS FROM integration_health WHERE Field='appKey'`)) as any;
  console.log("appKey column:", r[0]);
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });

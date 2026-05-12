/**
 * Sprint 2 verification — schema + behaviour checks for the security items.
 * Run with `DATABASE_URL` pointed at the env you want to verify.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import * as fs from "fs";

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const c = await mysql.createConnection(dbUrl);

  console.log("=== Sprint 2 verification ===\n");

  // 2.4 — connection_events table exists
  const [t] = await c.query<mysql.RowDataPacket[]>(
    "SHOW TABLES LIKE 'connection_events'",
  );
  console.log("2.4 connection_events table:", t.length > 0 ? "✓ EXISTS" : "✗ MISSING");

  if (t.length > 0) {
    const [cols] = await c.query<mysql.RowDataPacket[]>(
      "SHOW COLUMNS FROM connection_events",
    );
    console.log("    columns:", (cols as Array<{ Field: string }>).map((r) => r.Field).join(", "));
    const [n] = await c.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM connection_events",
    );
    console.log("    rows:", (n[0] as { n: number }).n);
  }

  // 2.1 — scrub helper is exported
  const routerCode = fs.readFileSync("server/routers/connectionsRouter.ts", "utf8");
  const scrubExists = routerCode.includes("scrubSecretsFromTemplateConfig");
  console.log("\n2.1 scrubSecretsFromTemplateConfig helper:", scrubExists ? "✓ EXISTS" : "✗ MISSING");

  // 2.2 — attentionCount procedure
  const attentionExists = routerCode.includes("attentionCount: protectedProcedure");
  console.log("\n2.2 connections.attentionCount procedure:", attentionExists ? "✓ EXISTS" : "✗ MISSING");

  const homeCode = fs.readFileSync("client/src/pages/Home.tsx", "utf8");
  const bannerExists = homeCode.includes("attention.total > 0") && homeCode.includes("need attention");
  console.log("    /overview banner JSX:", bannerExists ? "✓ PRESENT" : "✗ MISSING");

  // 2.3 — SECURITY category present
  const loggerCode = fs.readFileSync("server/services/appLogger.ts", "utf8");
  const secCategory = loggerCode.includes('"SECURITY"');
  console.log("\n2.3 SECURITY log category:", secCategory ? "✓ DEFINED" : "✗ MISSING");

  const dispatchCode = fs.readFileSync("server/integrations/dispatch.ts", "utf8");
  const ownerMismatchLoud = dispatchCode.includes('"SECURITY"') && dispatchCode.includes("log.error");
  console.log("    dispatch.ts owner-mismatch log.error:", ownerMismatchLoud ? "✓ LOUD" : "✗ SILENT");

  await c.end();
  console.log("\n=== Sprint 2 verification complete ===");
}
main().catch((e) => { console.error(e); process.exit(1); });

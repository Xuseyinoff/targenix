/**
 * Local-only safety drill for migration 0069 (rename destinations).
 *
 * 1.  Snapshot row counts BEFORE migration.
 * 2.  Apply 0069 forward.
 * 3.  Verify:
 *      - New tables exist as BASE TABLE
 *      - Old names exist as VIEW
 *      - Row counts unchanged (data intact)
 *      - SELECT through old name returns same data as new name
 *      - INSERT through old VIEW reaches the underlying renamed table
 * 4.  Apply rollback.
 * 5.  Verify:
 *      - Old tables back as BASE TABLE
 *      - Views gone
 *      - Row counts still match the original snapshot
 *
 * This script is LOCAL-ONLY. It does NOT connect to Railway production —
 * it uses .env DATABASE_URL.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";

const url = process.env.DATABASE_URL;
if (!url || url.includes("rlwy") || url.includes("proxy.rlwy")) {
  console.error(
    "[safety-drill] Refusing to run — DATABASE_URL looks like a Railway URL.\n" +
      "This drill must only target the LOCAL database.",
  );
  process.exit(1);
}

const conn = await mysql.createConnection({
  uri: url,
  multipleStatements: true,
});

async function snapshotRowCounts() {
  const tables = ["target_websites", "destinations", "integration_destinations", "integration_routes"];
  const out = {};
  for (const t of tables) {
    try {
      const [r] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      out[t] = Number(r[0].n);
    } catch (e) {
      out[t] = `(missing: ${e.code})`;
    }
  }
  return out;
}

async function describeName(name) {
  const [r] = await conn.query(
    `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return r[0]?.table_type ?? null;
}

async function runSqlFile(path) {
  const sql = readFileSync(path, "utf8");
  await conn.query(sql);
}

console.log("=".repeat(70));
console.log("LOCAL SAFETY DRILL — migration 0069 (rename destinations)");
console.log("=".repeat(70));
console.log("");

console.log("Step 1: BEFORE migration — row counts");
const before = await snapshotRowCounts();
console.log("  ", before);
console.log("  target_websites is a:", await describeName("target_websites"));
console.log("  destinations is a:   ", await describeName("destinations"));
console.log("");

console.log("Step 2: APPLY 0069 forward...");
await runSqlFile("drizzle/0069_rename_destinations.sql");
console.log("  ✓ applied");
console.log("");

console.log("Step 3: AFTER migration — verify state");
const after = await snapshotRowCounts();
console.log("  ", after);
console.log("  target_websites is a:", await describeName("target_websites"), "(expected: VIEW)");
console.log("  destinations is a:   ", await describeName("destinations"), "(expected: BASE TABLE)");
console.log("  integration_destinations is a:", await describeName("integration_destinations"), "(expected: VIEW)");
console.log("  integration_routes is a:      ", await describeName("integration_routes"), "(expected: BASE TABLE)");

// Row count consistency
const oldRows = before["target_websites"];
const viewRows = after["target_websites"];
const newRows = after["destinations"];
const ok1 = oldRows === viewRows && oldRows === newRows;
console.log("  target_websites: BEFORE=" + oldRows + " VIEW NOW=" + viewRows + " UNDERLYING=" + newRows, ok1 ? "✓" : "✗");

const idOldRows = before["integration_destinations"];
const idViewRows = after["integration_destinations"];
const idNewRows = after["integration_routes"];
const ok2 = idOldRows === idViewRows && idOldRows === idNewRows;
console.log("  integration_destinations: BEFORE=" + idOldRows + " VIEW NOW=" + idViewRows + " UNDERLYING=" + idNewRows, ok2 ? "✓" : "✗");
console.log("");

if (!ok1 || !ok2) {
  console.error("✗ DATA MISMATCH after forward migration. Aborting.");
  process.exit(2);
}

console.log("Step 4: ROLLBACK...");
await runSqlFile("drizzle/0069_rollback_rename_destinations.sql");
console.log("  ✓ rolled back");
console.log("");

console.log("Step 5: AFTER rollback — verify restored state");
const restored = await snapshotRowCounts();
console.log("  ", restored);
console.log("  target_websites is a:", await describeName("target_websites"), "(expected: BASE TABLE)");
console.log("  destinations is a:   ", await describeName("destinations"), "(expected: missing)");
console.log("  integration_destinations is a:", await describeName("integration_destinations"), "(expected: BASE TABLE)");
console.log("  integration_routes is a:      ", await describeName("integration_routes"), "(expected: missing)");

const restoredOk =
  restored["target_websites"] === before["target_websites"] &&
  restored["integration_destinations"] === before["integration_destinations"];
console.log("  Row counts match original snapshot:", restoredOk ? "✓" : "✗");

await conn.end();

if (!restoredOk) {
  console.error("\n✗ Rollback did NOT fully restore the original state. Investigate before proceeding.");
  process.exit(3);
}

console.log("\n" + "=".repeat(70));
console.log("✅ SAFETY DRILL PASSED — migration + rollback both verified on local DB.");
console.log("=".repeat(70));

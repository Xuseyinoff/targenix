/**
 * Manually apply 0064 + update __drizzle_migrations tracker.
 * Drift between journal and tracker — migrations 0063+ applied to DB but not logged.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import * as fs from "fs";
import * as crypto from "crypto";

async function main() {
  const sql = fs.readFileSync("drizzle/0064_webhook_events_signature_unique.sql", "utf8");
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  // Check if already applied
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhook_events' AND INDEX_NAME = 'uniq_webhook_events_signature'"
  );
  if (rows.length > 0) {
    console.log("[0064] Already applied — uniq_webhook_events_signature exists.");
    await conn.end();
    return;
  }

  // Dedupe in two phases — self-join DELETE on an unindexed column is O(n²)
  // and timed out on the 85k-row local table. Phase 1 picks the IDs to drop
  // (one GROUP BY scan), phase 2 deletes them by primary key (fast).
  const [keepRows] = await conn.query<mysql.RowDataPacket[]>(`
    SELECT signature, MIN(id) AS keep_id
    FROM webhook_events
    WHERE signature IS NOT NULL
    GROUP BY signature
    HAVING COUNT(*) > 1
  `);
  if (keepRows.length > 0) {
    console.log(`[0064] ${keepRows.length} duplicate signature groups found.`);
    const dupSignatures = keepRows.map((r) => r.signature as string);
    const keepIds = keepRows.map((r) => Number(r.keep_id));
    const [toDelete] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id FROM webhook_events WHERE signature IN (?) AND id NOT IN (?)`,
      [dupSignatures, keepIds],
    );
    const deleteIds = toDelete.map((r) => Number(r.id));
    console.log(`[0064] Deleting ${deleteIds.length} duplicate rows by primary key:`, deleteIds);
    if (deleteIds.length > 0) {
      const [delResult] = await conn.query<mysql.ResultSetHeader>(
        `DELETE FROM webhook_events WHERE id IN (?)`,
        [deleteIds],
      );
      console.log(`[0064] Deduped ${delResult.affectedRows} rows.`);
    }
  } else {
    console.log("[0064] No duplicate signatures — clean to add unique index.");
  }

  // Strip comments + drizzle breakpoint marker before execute
  const cleanSql = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();
  console.log("[0064] Applying SQL...\n", cleanSql);
  await conn.query(cleanSql);

  // Record in __drizzle_migrations to align with journal
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  const ts = 1778451600000;
  await conn.query(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    [hash, ts]
  );
  console.log(`[0064] Recorded migration hash=${hash.slice(0, 12)}...`);

  console.log("[0064] Done.");
  await conn.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

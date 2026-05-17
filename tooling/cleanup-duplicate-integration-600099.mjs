/**
 * One-shot cleanup — soft-delete integrations.id=600099.
 *
 * Context: 2026-05-17 audit found 1 live duplicate on
 * (userId=1893798, formId=1415829146966356, destinationId=60016).
 * Two rows: 600099 ("shlang 69k", paused since 2026-05-09) and
 * 600174 ("shlang 64k/30k", live, last dispatch today).
 *
 * 600099 has been paused (isActive=0) for 8 days, last order 2026-05-09.
 * 600174 is the active replacement. Soft-deleting 600099 unblocks the
 * UNIQUE constraint migration (0092) without changing dispatch behaviour.
 *
 * Idempotent: re-running after the first apply is a no-op.
 *
 * Usage: railway run --service=targenix.uz node tooling/cleanup-duplicate-integration-600099.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const ID = 600099;
const EXPECTED = {
  userId: 1893798,
  formId: "1415829146966356",
  destinationId: 60016,
  isActive: 0,
};

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("[cleanup-600099] No mysql:// URL in env.");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url });
let exitCode = 0;

try {
  const [rows] = await conn.query(
    `SELECT id, userId, formId, destinationId, isActive, deletedAt, name
       FROM integrations WHERE id = ?`,
    [ID],
  );
  if (rows.length === 0) {
    console.error(`[cleanup-600099] integration ${ID} NOT FOUND. Aborting.`);
    process.exit(1);
  }
  const row = rows[0];
  console.log("[cleanup-600099] Current row:");
  console.table([row]);

  // Sanity checks — make sure we're soft-deleting exactly the row we expect.
  for (const [k, v] of Object.entries(EXPECTED)) {
    const actual = String(row[k] ?? "");
    if (actual !== String(v)) {
      console.error(`[cleanup-600099] SANITY FAIL: expected ${k}=${v}, got ${actual}. Aborting.`);
      process.exit(1);
    }
  }

  if (row.deletedAt !== null) {
    console.log("[cleanup-600099] Row already soft-deleted — SKIP.");
    process.exit(0);
  }

  console.log("[cleanup-600099] Sanity checks passed. Setting deletedAt=NOW()…");
  const [res] = await conn.query(
    `UPDATE integrations SET deletedAt = NOW() WHERE id = ? AND deletedAt IS NULL`,
    [ID],
  );
  console.log(`[cleanup-600099] UPDATE result: affectedRows=${res.affectedRows}`);

  // Verify
  const [after] = await conn.query(
    `SELECT id, isActive, deletedAt FROM integrations WHERE id = ?`,
    [ID],
  );
  console.log("[cleanup-600099] After:");
  console.table(after);
  if (after[0].deletedAt === null) {
    console.error("[cleanup-600099] FAIL: deletedAt still NULL after UPDATE.");
    exitCode = 1;
  }
} catch (err) {
  console.error("[cleanup-600099] FATAL:", err.message);
  exitCode = 1;
} finally {
  await conn.end();
}

console.log(exitCode === 0 ? "\n[cleanup-600099] Done." : "\n[cleanup-600099] FAILED.");
process.exit(exitCode);

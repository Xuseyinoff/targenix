/**
 * Backfill integrations.facebookAccountId from config JSON.
 *
 * Config JSON uses two possible key names (historical inconsistency):
 *   - config.facebookAccountId  (new format)
 *   - config.accountId          (old format)
 *
 * Only updates LEAD_ROUTING rows where facebookAccountId IS NULL and
 * the JSON contains a valid numeric account ID.
 *
 * Safe to re-run — skips rows that are already populated.
 */

import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("No DB URL found. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

console.log("[backfill] Connected to DB");

// Fetch all LEAD_ROUTING integrations with NULL facebookAccountId
const [rows] = await conn.execute(
  `SELECT id, config FROM integrations
   WHERE type = 'LEAD_ROUTING' AND facebookAccountId IS NULL`
);

console.log(`[backfill] Found ${rows.length} rows to process`);

let updated = 0;
let skipped = 0;

for (const row of rows) {
  let cfg;
  try {
    cfg = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  } catch {
    console.warn(`[backfill] id=${row.id} — invalid JSON, skipping`);
    skipped++;
    continue;
  }

  // Try both key names; prefer facebookAccountId over accountId
  const raw = cfg?.facebookAccountId ?? cfg?.accountId;
  const accountId = typeof raw === "number" && raw > 0 ? raw
    : typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw)
    : null;

  if (!accountId) {
    skipped++;
    continue;
  }

  await conn.execute(
    `UPDATE integrations SET facebookAccountId = ? WHERE id = ?`,
    [accountId, row.id]
  );
  updated++;
}

await conn.end();

console.log(`[backfill] Done — updated: ${updated}, skipped: ${skipped}`);

/**
 * Apply migration 0085 — Insights Phase 1 schema.
 *
 * Adds:
 *   • users.baseCurrency           VARCHAR(8)  NOT NULL DEFAULT 'USD'
 *   • ad_accounts.bmId             VARCHAR(64) NULL  (+ idx_ad_accounts_bm_id)
 *   • ad_accounts.bmName           VARCHAR(255) NULL
 *   • orders.offerId               VARCHAR(64) NULL  (+ idx_orders_user_offer_created)
 *   • orders.payoutAmount          INT NULL
 *   • fact_attribution_daily       (new rollup table)
 *
 * All ALTERs are MySQL-8 INSTANT DDL (metadata-only). Idempotent. Prints
 * BEFORE/AFTER state so the change is visible in the run log.
 *
 * Usage:
 *   railway run node tooling/apply-0085-insights-phase1.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

// Railway exposes MYSQL_PUBLIC_URL (external) and MYSQL_URL (internal). Local
// runs typically set DATABASE_URL. Pick whichever is present.
const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url) {
  console.error("No MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL set");
  process.exit(1);
}
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

async function describe() {
  const [usersCols] = await conn.query(
    `SELECT column_name, column_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'baseCurrency'`,
  );
  const [adAcctCols] = await conn.query(
    `SELECT column_name, column_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'ad_accounts'
        AND column_name IN ('bmId', 'bmName')
      ORDER BY column_name`,
  );
  const [ordersCols] = await conn.query(
    `SELECT column_name, column_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'orders'
        AND column_name IN ('offerId', 'payoutAmount')
      ORDER BY column_name`,
  );
  const [factTable] = await conn.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = 'fact_attribution_daily'`,
  );
  const [factCols] = factTable.length
    ? await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND table_name = 'fact_attribution_daily'`,
      )
    : [[{ n: 0 }]];
  const [adAcctIdx] = await conn.query(
    `SELECT index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'ad_accounts'
        AND index_name = 'idx_ad_accounts_bm_id'`,
  );
  const [ordersIdx] = await conn.query(
    `SELECT index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'orders'
        AND index_name = 'idx_orders_user_offer_created'`,
  );

  return {
    usersCols,
    adAcctCols,
    ordersCols,
    factTablePresent: factTable.length > 0,
    factColCount: Number(factCols[0]?.n ?? 0),
    adAcctIdxPresent: adAcctIdx.length > 0,
    ordersIdxPresent: ordersIdx.length > 0,
  };
}

function printState(label, s) {
  console.log(`\n[0085] ${label}:`);
  console.log("  users.baseCurrency:");
  console.table(s.usersCols);
  console.log("  ad_accounts (bmId, bmName):");
  console.table(s.adAcctCols);
  console.log("  orders (offerId, payoutAmount):");
  console.table(s.ordersCols);
  console.log(
    `  fact_attribution_daily: ${s.factTablePresent ? `present (${s.factColCount} columns)` : "ABSENT"}`,
  );
  console.log(`  idx_ad_accounts_bm_id:           ${s.adAcctIdxPresent ? "present" : "absent"}`);
  console.log(`  idx_orders_user_offer_created:   ${s.ordersIdxPresent ? "present" : "absent"}`);
}

printState("BEFORE", await describe());

await conn.query(readFileSync("drizzle/0085_insights_phase1.sql", "utf8"));

printState("AFTER", await describe());

console.log("\n[0085] Done.");
await conn.end();

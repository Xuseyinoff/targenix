/**
 * Apply migration 0083 — covering index orders(leadId, userId, attempts).
 * MySQL 8 InnoDB CREATE INDEX is ONLINE. Idempotent. Prints before/after
 * EXPLAIN of the leads.list EXISTS subquery so the speedup is visible.
 *
 * Usage:
 *   pnpm exec dotenvx run -- node tooling/apply-0083-orders-index.mjs
 *   railway run --service targenix.uz node tooling/apply-0083-orders-index.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const conn = await mysql.createConnection({ uri: url, multipleStatements: true });

// Pick any userId that has routed leads — for a representative EXPLAIN.
const [[sampleUser]] = await conn.query(
  `SELECT userId FROM orders WHERE attempts > 0 GROUP BY userId ORDER BY COUNT(*) DESC LIMIT 1`,
);
const uid = sampleUser?.userId ?? 1;

const explainSql = `EXPLAIN SELECT l.id FROM leads l
   WHERE l.userId = ${uid}
     AND EXISTS (SELECT 1 FROM orders o WHERE o.leadId = l.id AND o.userId = ${uid} AND o.attempts > 0)
   ORDER BY l.createdAt DESC LIMIT 50`;

async function timedCount() {
  const t0 = Date.now();
  await conn.query(
    `SELECT COUNT(*) AS n FROM leads l WHERE l.userId = ${uid}
       AND EXISTS (SELECT 1 FROM orders o WHERE o.leadId = l.id AND o.userId = ${uid} AND o.attempts > 0)`,
  );
  return Date.now() - t0;
}

console.log(`[0083] Sample userId for EXPLAIN: ${uid}`);
console.log("[0083] BEFORE — EXPLAIN:");
console.table((await conn.query(explainSql))[0].map((r) => ({ table: r.table, type: r.type, key: r.key, rows: r.rows, Extra: r.Extra })));
console.log(`[0083] BEFORE — getLeadsCount: ${await timedCount()}ms`);

await conn.query(readFileSync("drizzle/0083_orders_lead_user_attempts_index.sql", "utf8"));

console.log("\n[0083] AFTER — EXPLAIN:");
console.table((await conn.query(explainSql))[0].map((r) => ({ table: r.table, type: r.type, key: r.key, rows: r.rows, Extra: r.Extra })));
console.log(`[0083] AFTER — getLeadsCount: ${await timedCount()}ms`);

console.log("\n[0083] Done.");
await conn.end();

/**
 * Real evidence for "auto order retry" health:
 * 1) Overdue: FAILED, nextRetryAt in the PAST, attempts < 3  → should have been picked by retryDueFailedOrders
 * 2) No schedule: FAILED, nextRetryAt NULL, attempts < 3    → will NEVER be auto-retried (e.g. validation error in policy)
 *
 * Usage: railway run node tooling/mysql/report-retry-backlog.mjs
 */
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  process.env.MYSQL_URL?.trim();
if (!url) {
  console.error("No MySQL URL");
  process.exit(1);
}

const c = await mysql.createConnection(url);

const [[{ overdue }]] = await c.query(
  `SELECT COUNT(*) AS overdue FROM orders
   WHERE status = 'FAILED'
     AND attempts < 3
     AND nextRetryAt IS NOT NULL
     AND nextRetryAt < UTC_TIMESTAMP()`,
);

const [[{ noSchedule }]] = await c.query(
  `SELECT COUNT(*) AS noSchedule FROM orders
   WHERE status = 'FAILED'
     AND attempts < 3
     AND nextRetryAt IS NULL`,
);

const [oldest] = await c.query(
  `SELECT id, leadId, attempts, nextRetryAt,
     TIMESTAMPDIFF(MINUTE, nextRetryAt, UTC_TIMESTAMP()) AS minutes_overdue
   FROM orders
   WHERE status = 'FAILED'
     AND attempts < 3
     AND nextRetryAt IS NOT NULL
     AND nextRetryAt < UTC_TIMESTAMP()
   ORDER BY nextRetryAt ASC
   LIMIT 5`,
);

console.log("=== Order auto-retry evidence (DB truth) ===\n");
console.log("UTC now (DB):  run SELECT UTC_TIMESTAMP() in MySQL if you need to compare");
console.log("");
console.log("1) OVERDUE (nextRetryAt already passed — job SHOULD pick these):", overdue);
if (oldest.length) {
  console.log("   Oldest 5 (id, leadId, attempts, nextRetryAt, minutes_overdue):");
  console.table(oldest);
} else {
  console.log("   (none) — no backlog in this category.");
}
console.log("");
console.log("2) FAILED but NO nextRetryAt (policy = never auto-retry, e.g. validation):", noSchedule);
console.log("   Manual user retry can still work via processLead; hourly order retry ignores these.");

await c.end();

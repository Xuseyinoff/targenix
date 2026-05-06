/**
 * Show exactly what the order retry scheduler would consider "due",
 * and whether each due order has a matching lead row.
 *
 * Usage: railway run node tooling/mysql/report-due-orders-sample.mjs
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

const where = `
  o.status = 'FAILED'
  AND o.attempts < 3
  AND o.nextRetryAt IS NOT NULL
  AND o.nextRetryAt <= UTC_TIMESTAMP()
`;

const [[nowRow]] = await c.query(`SELECT UTC_TIMESTAMP() AS utc_now`);
console.log("UTC now:", nowRow.utc_now);

const [[cnt]] = await c.query(
  `SELECT
     COUNT(*) AS due_total,
     SUM(CASE WHEN l.id IS NULL THEN 1 ELSE 0 END) AS due_orphan,
     SUM(CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END) AS due_has_lead
   FROM orders o
   LEFT JOIN leads l ON l.id = o.leadId
   WHERE ${where}`,
);

console.log("Due orders (scheduler criteria):", {
  due_total: Number(cnt.due_total),
  due_orphan: Number(cnt.due_orphan),
  due_has_lead: Number(cnt.due_has_lead),
});

const [sample] = await c.query(
  `SELECT
     o.id AS order_id,
     o.leadId,
     o.integrationId,
     o.destinationId,
     o.attempts,
     o.nextRetryAt,
     l.id AS lead_exists
   FROM orders o
   LEFT JOIN leads l ON l.id = o.leadId
   WHERE ${where}
   ORDER BY o.nextRetryAt ASC
   LIMIT 15`,
);

console.log("\nTop 15 due orders (oldest nextRetryAt first):");
console.table(sample);

await c.end();
console.log("\nDone.");


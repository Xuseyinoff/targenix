/**
 * One-shot probe: ERROR-parked leads for user 1893631 since 2026-05-18 00:00 UTC.
 * Surfaces what auto-recovery missed because polling skips on leadgenId match.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const USER_ID = 1893631;
const SINCE = "2026-05-18 00:00:00";

const conn = await mysql.createConnection({
  uri: process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL,
});

const [parked] = await conn.query(
  `SELECT id, leadgenId, pageId, formId, dataStatus, dataAttempts, deliveryStatus, createdAt
     FROM leads
    WHERE userId = ?
      AND dataStatus = 'ERROR'
      AND createdAt >= ?
    ORDER BY createdAt DESC
    LIMIT 50`,
  [USER_ID, SINCE],
);
console.log(`\nPARKED ERROR LEADS for uid=${USER_ID} since ${SINCE}: ${parked.length}\n`);
console.table(
  parked.map((l) => ({
    id: l.id,
    leadgenId: String(l.leadgenId),
    formId: String(l.formId),
    attempts: l.dataAttempts,
    dataStatus: l.dataStatus,
    deliveryStatus: l.deliveryStatus,
    created: l.createdAt,
  })),
);

const [byForm] = await conn.query(
  `SELECT formId, COUNT(*) AS n
     FROM leads
    WHERE userId = ?
      AND dataStatus = 'ERROR'
      AND createdAt >= ?
    GROUP BY formId
    ORDER BY n DESC`,
  [USER_ID, SINCE],
);
console.log("\nBY FORM:");
console.table(byForm);

const [latest] = await conn.query(
  `SELECT MAX(createdAt) AS latestLead, COUNT(*) AS totalLeadsEver
     FROM leads
    WHERE userId = ?`,
  [USER_ID],
);
console.log("\nUSER OVERALL:");
console.table(latest);

const [allStatuses] = await conn.query(
  `SELECT dataStatus, COUNT(*) AS n
     FROM leads
    WHERE userId = ?
      AND createdAt >= ?
    GROUP BY dataStatus`,
  [USER_ID, SINCE],
);
console.log("\nALL DATA-STATUS BUCKETS TODAY:");
console.table(allStatuses);

await conn.end();

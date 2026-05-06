/**
 * One-off report: yesterday 00:00–today 00:00 (Asia/Tashkent) in DB time.
 * Usage: railway run node tooling/mysql/report-yesterday-failed-tashkent.mjs
 * Requires: MYSQL_URL or MYSQL_PUBLIC_URL or DATABASE_URL
 */
import mysql from "mysql2/promise";

const TZ = "Asia/Tashkent";

function getYesterdayWindowTashkent() {
  const now = new Date();
  const todayYmd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const endExclusive = new Date(`${todayYmd}T00:00:00+05:00`);
  const noon = new Date(`${todayYmd}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() - 1);
  const ystr = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(noon);
  const startInclusive = new Date(`${ystr}T00:00:00+05:00`);
  return { startInclusive, endExclusive, labelStart: ystr, labelEndExclusive: todayYmd };
}

// Prefer PUBLIC URL: local `railway run` cannot resolve mysql.railway.internal.
const url =
  process.env.MYSQL_PUBLIC_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  process.env.MYSQL_URL?.trim();
if (!url) {
  console.error("No MYSQL_URL / MYSQL_PUBLIC_URL / DATABASE_URL");
  process.exit(1);
}

const { startInclusive, endExclusive, labelStart, labelEndExclusive } = getYesterdayWindowTashkent();
const c = await mysql.createConnection(url);

console.log("=== Tashkent calendar day (yesterday) ===");
console.log(`Window: [${labelStart} 00:00, ${labelEndExclusive} 00:00) Asia/Tashkent`);
console.log(`UTC:    [${startInclusive.toISOString()}, ${endExclusive.toISOString()})`);
console.log("");

// Failed leads: created in window and (delivery failed/partial or graph error)
const [failedLeads] = await c.execute(
  `SELECT COUNT(*) AS n
   FROM leads
   WHERE createdAt >= ? AND createdAt < ?
     AND (deliveryStatus IN ('FAILED','PARTIAL') OR dataStatus = 'ERROR')`,
  [startInclusive, endExclusive],
);
console.log("Failed leads (created in window, status FAILED/PARTIAL delivery OR data ERROR):", failedLeads[0].n);

// All leads created that day (context)
const [allLeads] = await c.execute(
  `SELECT COUNT(*) AS n FROM leads WHERE createdAt >= ? AND createdAt < ?`,
  [startInclusive, endExclusive],
);
console.log("All leads created in same window (context):", allLeads[0].n);
console.log("");

// Failed orders: created in window with status FAILED + attempts distribution
const [failedOrders] = await c.execute(
  `SELECT
     COUNT(*) AS order_rows,
     COALESCE(SUM(attempts),0) AS total_attempts_sum,
     MAX(attempts) AS max_attempts_in_window
   FROM orders
   WHERE createdAt >= ? AND createdAt < ?
     AND status = 'FAILED'`,
  [startInclusive, endExclusive],
);
const row = failedOrders[0];
console.log("Failed orders (order rows, status=FAILED, created in window):");
console.log("  count(order rows):     ", row.order_rows);
console.log("  sum(attempts) [total delivery tries logged]:", row.total_attempts_sum);
console.log("  max(attempts) on a row:", row.max_attempts_in_window);
console.log("");

const [byAttempts] = await c.execute(
  `SELECT attempts AS n, COUNT(*) AS cnt
   FROM orders
   WHERE createdAt >= ? AND createdAt < ? AND status = 'FAILED'
   GROUP BY attempts
   ORDER BY attempts`,
  [startInclusive, endExclusive],
);
console.log("Failed orders by attempts value:");
if (byAttempts.length === 0) console.log("  (none)");
else console.table(byAttempts);

await c.end();
console.log("\nDone.");

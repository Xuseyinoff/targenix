/**
 * Inspect `app_actions` actionKey usage (read-only).
 *
 * Usage:
 *   railway run node tooling/drizzle/inspect-app-actions.mjs
 */
import mysql from "mysql2/promise";
 
function getMysqlUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}
 
async function main() {
  const url = getMysqlUrl();
  if (!url) {
    console.error("Need mysql:// URL (MYSQL_PUBLIC_URL/MYSQL_URL/DATABASE_URL)");
    process.exit(1);
  }
  const cn = await mysql.createConnection(url);
  try {
    const [rows] = await cn.query(
      "SELECT appKey, actionKey, COUNT(1) AS c FROM app_actions WHERE actionKey REGEXP '^t[0-9]+$' GROUP BY appKey, actionKey ORDER BY appKey, actionKey LIMIT 200",
    );
    console.log(rows);
    const [[sum]] = await cn.query(
      "SELECT COUNT(1) AS n FROM app_actions WHERE actionKey REGEXP '^t[0-9]+$'",
    );
    console.log({ tN_total: Number(sum.n) });
  } finally {
    await cn.end();
  }
}
 
main().catch((e) => {
  console.error(e);
  process.exit(1);
});


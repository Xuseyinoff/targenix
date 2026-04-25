/**
 * Verify google_accounts is dropped (Railway).
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/mysql/verify-google-accounts-dropped.mjs
 */
import mysql from "mysql2/promise";

function pickMysqlUrl() {
  for (const raw of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

const url = pickMysqlUrl();
if (!url) {
  console.error("No mysql:// URL found in env");
  process.exit(2);
}

const cn = await mysql.createConnection(url);
try {
  const [t] = await cn.query("SHOW TABLES LIKE 'google_accounts'");
  const [[c1]] = await cn.query("SELECT COUNT(1) AS c FROM oauth_tokens WHERE appKey='google-sheets'");
  console.log(JSON.stringify({ google_accounts_exists: t.length > 0, oauth_tokens_google_sheets: Number(c1.c) }, null, 2));
} finally {
  await cn.end();
}


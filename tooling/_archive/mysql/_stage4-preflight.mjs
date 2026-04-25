/**
 * Stage 4 preflight — READ ONLY.
 *
 * Clarifies schema: `connectionId` lives on `target_websites`, NOT on
 * `integration_destinations` (join table is integration ↔ target_website only).
 *
 * Usage (Railway):
 *   railway run --service targenix.uz node tooling/mysql/_stage4-preflight.mjs
 */

import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) {
  console.error("Need mysql:// URL");
  process.exit(1);
}

const cn = await mysql.createConnection(url);
try {
  const [cols] = await cn.query(
    "SHOW COLUMNS FROM integration_destinations LIKE 'connectionId'",
  );
  console.log("─── Schema check ───");
  console.log(
    "integration_destinations.connectionId column exists:",
    cols.length > 0 ? "YES (unexpected vs current drizzle schema)" : "NO",
  );

  const [[twNull]] = await cn.query(`
    SELECT COUNT(*) AS n
      FROM target_websites
     WHERE isActive = 1
       AND connectionId IS NULL
  `);
  console.log(
    "Active target_websites with connectionId IS NULL:",
    twNull.n,
  );

  const [[twNullSecrets]] = await cn.query(`
    SELECT COUNT(*) AS n
      FROM target_websites
     WHERE isActive = 1
       AND connectionId IS NULL
       AND JSON_LENGTH(COALESCE(JSON_EXTRACT(templateConfig, '$.secrets'), '[]')) > 0
  `);
  console.log(
    "…of those, with non-empty templateConfig.secrets (JSON):",
    twNullSecrets.n,
  );

  const [[idRows]] = await cn.query(`
    SELECT COUNT(*) AS n FROM integration_destinations WHERE enabled = 1
  `);
  console.log("Enabled integration_destinations rows:", idRows.n);
} finally {
  await cn.end();
}

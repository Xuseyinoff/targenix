/**
 * Post-deploy verification for Commit 4 on Railway.
 * Confirms integration_destinations row count matches the legacy source
 * and spot-checks one mirrored row.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// The legacy source for dispatch is:
//   COALESCE(integrations.targetWebsiteId, config.targetWebsiteId)
// — the dedicated column was added mid-life and only freshly-created rows
// ever got it populated. We compare the new table against that UNION.
const [[counts]] = await conn.execute(`
  SELECT
    (SELECT COUNT(*) FROM integrations
      WHERE type='LEAD_ROUTING'
        AND (targetWebsiteId IS NOT NULL
             OR JSON_EXTRACT(config, '$.targetWebsiteId') IS NOT NULL))
      AS legacy_resolvable,
    (SELECT COUNT(*) FROM integrations
      WHERE type='LEAD_ROUTING' AND targetWebsiteId IS NOT NULL)
      AS legacy_col_only,
    (SELECT COUNT(*) FROM integration_destinations) AS dest_rows,
    (SELECT COUNT(DISTINCT integrationId) FROM integration_destinations) AS distinct_integrations,
    (SELECT COUNT(*) FROM integration_destinations WHERE enabled = 1) AS enabled_rows
`);
console.log("[verify] counts:", counts);

const [[sample]] = await conn.execute(`
  SELECT id.*, i.name, tw.name AS twName
    FROM integration_destinations id
    JOIN integrations i ON i.id = id.integrationId
    JOIN target_websites tw ON tw.id = id.targetWebsiteId
   ORDER BY id.id ASC LIMIT 1
`);
console.log("[verify] sample row:", sample);

const ok = Number(counts.legacy_resolvable) === Number(counts.dest_rows);
console.log(
  `[verify] ${ok ? "OK" : "MISMATCH"} legacy_resolvable=${counts.legacy_resolvable} dest_rows=${counts.dest_rows}`,
);
if (ok) {
  console.log(
    `[verify] (legacy column was only populated for ${counts.legacy_col_only} rows — the rest were mirrored from config JSON, which is expected.)`,
  );
}
await conn.end();
process.exit(ok ? 0 : 1);

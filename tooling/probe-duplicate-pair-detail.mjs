/**
 * Read-only — detail on the two duplicate integration rows so we can pick
 * which to soft-delete before the unique constraint migration.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection({ uri: url });

try {
  const [rows] = await conn.query(`
    SELECT id, userId, name, pageId, formId, destinationId, isActive,
           deletedAt, createdAt
    FROM integrations
    WHERE id IN (600099, 600174)
    ORDER BY id
  `);
  console.log("[detail] The duplicate pair:");
  console.table(rows);

  // Lead counts per integration (via leads.formId — proxy)
  const [leads] = await conn.query(`
    SELECT i.id AS integration_id, i.name,
           (SELECT COUNT(*) FROM leads WHERE userId=i.userId AND formId=i.formId) AS total_form_leads
    FROM integrations i
    WHERE i.id IN (600099, 600174)
  `);
  console.log("[detail] Form-level lead volume (same for both since same form):");
  console.table(leads);

  // Recent orders dispatched via the integrations
  const [orders600099] = await conn.query(
    `SELECT COUNT(*) AS n, MAX(createdAt) AS last
       FROM orders WHERE integrationId = 600099`,
  );
  const [orders600174] = await conn.query(
    `SELECT COUNT(*) AS n, MAX(createdAt) AS last
       FROM orders WHERE integrationId = 600174`,
  );
  console.log("[detail] Order dispatch history per row:");
  console.table([
    { integration_id: 600099, ...orders600099[0] },
    { integration_id: 600174, ...orders600174[0] },
  ]);

  // Also the destination they share
  const [dest] = await conn.query(
    `SELECT id, userId, name, appKey, url FROM destinations WHERE id = 60016`,
  );
  console.log("[detail] Shared destination (id=60016):");
  console.table(dest);
} catch (err) {
  console.error("[detail] FATAL:", err.message);
  process.exit(1);
} finally {
  await conn.end();
}

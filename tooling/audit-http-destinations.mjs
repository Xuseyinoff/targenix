/**
 * Audit destinations using the three apps that will be folded into the new
 * universal `http-request` app: webhook-json, plain-url, crm-generic.
 *
 * Prints counts per appKey, plus a small sample of `templateConfig` shapes
 * so the migration script knows exactly which keys it needs to translate.
 */
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

const TARGETS = ["webhook-json", "plain-url", "crm-generic"];

try {
  console.log("=== ALL destinations by appKey (full prod inventory) ===");
  const [allCounts] = await conn.query(
    `SELECT appKey, COUNT(*) AS n, SUM(isActive) AS active_n
     FROM destinations
     GROUP BY appKey ORDER BY n DESC`,
  );
  for (const r of allCounts) {
    console.log(`  ${(r.appKey ?? "<NULL>").padEnd(20)} total=${r.n}  active=${r.active_n}`);
  }

  console.log("\n=== Destinations by appKey (targets only) ===");
  const [counts] = await conn.query(
    `SELECT appKey, COUNT(*) AS n, SUM(isActive) AS active_n,
            SUM(connectionId IS NOT NULL) AS with_conn
     FROM destinations
     WHERE appKey IN (${TARGETS.map(() => "?").join(",")})
     GROUP BY appKey
     ORDER BY n DESC`,
    TARGETS,
  );
  for (const r of counts) {
    console.log(`  ${r.appKey.padEnd(16)} total=${r.n}  active=${r.active_n}  with_connection=${r.with_conn}`);
  }
  if (counts.length === 0) console.log("  (no destinations of these types — nothing to migrate)");

  for (const key of TARGETS) {
    console.log(`\n=== Sample templateConfig for appKey="${key}" (up to 3 rows) ===`);
    const [rows] = await conn.query(
      `SELECT id, name, url, connectionId, templateConfig
       FROM destinations
       WHERE appKey = ? AND isActive = 1
       ORDER BY id DESC LIMIT 3`,
      [key],
    );
    if (rows.length === 0) {
      console.log("  (no active rows)");
      continue;
    }
    for (const r of rows) {
      const cfg = typeof r.templateConfig === "string" ? JSON.parse(r.templateConfig) : r.templateConfig;
      console.log(`  id=${r.id} name="${r.name}" url=${r.url ?? "<null>"} connectionId=${r.connectionId ?? "<null>"}`);
      console.log(`    config keys: [${Object.keys(cfg ?? {}).join(", ")}]`);
      // Redact sensitive values when previewing
      const preview = JSON.stringify(cfg, (k, v) => {
        if (k === "apiKey" || k === "apiKeyEncrypted" || k === "bearerToken" || /token/i.test(k) || /secret/i.test(k)) {
          return typeof v === "string" ? `<${v.length} chars>` : v;
        }
        return v;
      }, 2);
      console.log(`    config (redacted): ${preview.length > 600 ? preview.slice(0, 600) + " ..." : preview}`);
    }
  }

  console.log("\n=== Active destinations with connectionId (Bearer auth scenario) ===");
  const [crmRows] = await conn.query(
    `SELECT d.id, d.name, d.appKey, d.connectionId, c.type AS conn_type, c.status AS conn_status
     FROM destinations d
     LEFT JOIN connections c ON c.id = d.connectionId
     WHERE d.appKey = 'crm-generic' AND d.isActive = 1
     LIMIT 10`,
  );
  for (const r of crmRows) {
    console.log(`  id=${r.id} ${r.appKey} → connection ${r.connectionId} (${r.conn_type}/${r.conn_status})`);
  }
  if (crmRows.length === 0) console.log("  (no active crm-generic rows)");
} finally {
  await conn.end();
}

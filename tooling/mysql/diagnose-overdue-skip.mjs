/**
 * For FAILED orders with overdue nextRetryAt, classify skip reasons.
 */
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  process.env.MYSQL_URL?.trim();
if (!url) {
  process.exit(1);
}

const c = await mysql.createConnection(url);

const base = `o.status = 'FAILED'
     AND o.attempts < 3
     AND o.nextRetryAt IS NOT NULL
     AND o.nextRetryAt < UTC_TIMESTAMP()`;

const [orphan] = await c.query(
  `SELECT COUNT(*) AS n FROM orders o
   LEFT JOIN leads l ON l.id = o.leadId
   WHERE ${base} AND l.id IS NULL`,
);
const [withLead] = await c.query(
  `SELECT COUNT(*) AS n FROM orders o
   INNER JOIN leads l ON l.id = o.leadId
   WHERE ${base}`,
);
{
  const [a] = await c.query(`SELECT COUNT(*) n FROM orders o WHERE ${base}`);
  console.log("Overdue (orders-only count):", a[0].n);
}
console.log("  with matching lead row:", Number(withLead[0].n));
console.log("  orphan (no lead row):     ", Number(orphan[0].n));

const [rows] = await c.query(
  `SELECT
     o.id AS order_id,
     o.leadId,
     o.attempts,
     o.nextRetryAt,
     o.integrationId,
     o.destinationId,
     l.dataStatus AS lead_data_status,
     l.pageId AS lead_page,
     l.formId AS lead_form,
     i.id AS int_id,
     i.type AS int_type,
     i.isActive AS int_active,
     i.pageId AS int_page,
     i.formId AS int_form
   FROM orders o
   INNER JOIN leads l ON l.id = o.leadId
   LEFT JOIN integrations i ON i.id = o.integrationId AND i.userId = o.userId
   WHERE ${base}`,
);

function classify(r) {
  if (!r.int_id) return "no_integration";
  if (r.lead_data_status !== "ENRICHED") return "lead_not_enriched";
  if (Number(r.int_active) === 0) return "integration_inactive";
  if (r.int_type !== "AFFILIATE" && r.int_type !== "LEAD_ROUTING")
    return "type_not_affiliate_or_routing:" + (r.int_type || "?");
  if (r.int_type === "LEAD_ROUTING") {
    if ((r.int_page || "") !== (r.lead_page || "") || (r.int_form || "") !== (r.lead_form || "")) {
      return "lead_routing_page_form_mismatch";
    }
  }
  if (r.destinationId > 0) return "needs_dest_mapping_check";
  return "would_call_runOrderIntegrationSend";
}

const counts = {};
for (const r of rows) {
  const k = classify(r);
  counts[k] = (counts[k] || 0) + 1;
}

console.log("\nClassify overdue rows (with lead):", rows.length);
console.log(counts);

const [dcheck] = await c.query(
  `SELECT
     CASE
       WHEN o.destinationId <= 0 THEN 'no_mapping_needed'
       WHEN m.id IS NULL THEN 'missing_mapping'
       WHEN m.enabled = 0 THEN 'disabled_mapping'
       WHEN tw.userId <> o.userId THEN 'dest_owner_mismatch'
       ELSE 'mapping_ok'
     END AS dest_state,
     COUNT(*) AS n
   FROM orders o
   JOIN leads l ON l.id = o.leadId
   LEFT JOIN integration_destinations m ON m.id = o.destinationId AND m.integrationId = o.integrationId
   LEFT JOIN target_websites tw ON tw.id = m.targetWebsiteId
   WHERE ${base}
   GROUP BY dest_state`,
);
console.log("\nDestination mapping state (overdue):");
console.table(dcheck);

await c.end();

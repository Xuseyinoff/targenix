/**
 * Read-only report for `target_websites` rows (NO_TEMPLATE cohort or explicit IDs):
 *   createdAt, userId, integration links, recent order/lead activity.
 * No HTTP "creation source" is stored in MySQL — only timestamps; we note that in output.
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/mysql/report-no-template-usage.mjs
 *   railway run --service targenix.uz node tooling/mysql/report-no-template-usage.mjs --ids=30003,60001
 */

import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

function parseArgs(argv) {
  let ids = null;
  for (const a of argv) {
    if (a.startsWith("--ids=")) {
      ids = a
        .slice("--ids=".length)
        .split(",")
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => !Number.isNaN(n));
    }
  }
  return { ids };
}

async function main() {
  const { ids: customIds } = parseArgs(process.argv.slice(2));
  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL url in env.");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const where =
      customIds && customIds.length
        ? `tw.id IN (${customIds.map(() => "?").join(",")})`
        : `tw.isActive = 1 AND tw.connectionId IS NULL AND tw.templateId IS NULL`;

    const params = customIds && customIds.length ? customIds : [];

    const [rows] = await conn.query(
      `
      SELECT
        tw.id,
        tw.userId,
        tw.name,
        tw.url,
        tw.templateType,
        tw.isActive,
        tw.connectionId,
        tw.templateId,
        tw.createdAt,
        u.email AS userEmail
      FROM target_websites tw
      LEFT JOIN users u ON u.id = tw.userId
      WHERE ${where}
      ORDER BY tw.id ASC
      `,
      params,
    );

    console.log(
      "\n" +
        "═".repeat(76) +
        "\n  NO-TEMPLATE / usage report (read-only, no DB writes)\n" +
        "  Note: MySQL does not store whether a row was created via HTTP API vs UI — only createdAt.\n" +
        "═".repeat(76) +
        "\n",
    );

    for (const r of rows) {
      const twId = r.id;
      // Integrations: legacy column and/or multi-dest rows
      const [[d]] = await conn.query(
        `
        SELECT
          (SELECT COUNT(*) FROM integrations i
            WHERE i.targetWebsiteId = ? AND i.isActive = 1) AS n_direct
        `,
        [twId],
      );
      const [[m]] = await conn.query(
        `
        SELECT COUNT(DISTINCT d.integrationId) AS n_multi
          FROM integration_destinations d
          JOIN integrations i ON i.id = d.integrationId
         WHERE d.targetWebsiteId = ?
           AND d.enabled = 1
           AND i.isActive = 1
        `,
        [twId],
      );
      // Orders in last 7d / 30d that target this website (any path)
      const [[o7]] = await conn.query(
        `
        SELECT COUNT(DISTINCT o.id) AS n, MAX(o.createdAt) AS lastAt
          FROM orders o
          JOIN integrations i ON i.id = o.integrationId
         WHERE o.createdAt >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
           AND (i.targetWebsiteId = ?
             OR EXISTS (
               SELECT 1 FROM integration_destinations d
                WHERE d.integrationId = i.id
                  AND d.targetWebsiteId = ?
                  AND d.enabled = 1
             ))
        `,
        [twId, twId],
      );
      const [[o30]] = await conn.query(
        `
        SELECT COUNT(DISTINCT o.id) AS n, MAX(o.createdAt) AS lastAt
          FROM orders o
          JOIN integrations i ON i.id = o.integrationId
         WHERE o.createdAt >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
           AND (i.targetWebsiteId = ?
             OR EXISTS (
               SELECT 1 FROM integration_destinations d
                WHERE d.integrationId = i.id
                  AND d.targetWebsiteId = ?
                  AND d.enabled = 1
             ))
        `,
        [twId, twId],
      );

      // Sample integration ids (up to 5) for follow-up
      const [integRows] = await conn.query(
        `
        SELECT i.id, i.type, i.name, i.isActive, i.pageId, i.formId, i.targetWebsiteId
          FROM integrations i
         WHERE (i.targetWebsiteId = ? OR EXISTS (
           SELECT 1 FROM integration_destinations d
            WHERE d.integrationId = i.id AND d.targetWebsiteId = ? AND d.enabled = 1
         ))
         ORDER BY i.id ASC
         LIMIT 8
        `,
        [twId, twId],
      );

      const totalLinked =
        Math.max(0, d.n_direct) > 0 || Math.max(0, m.n_multi) > 0
          ? "yes (see detail)"
          : "none found";

      console.log(`── target_websites id=${twId}  userId=${r.userId}  name=${r.name}`);
      console.log(
        `   createdAt: ${r.createdAt ? new Date(r.createdAt).toISOString() : "null"}`,
      );
      console.log(
        `   user: email=${r.userEmail ?? "—"}`,
      );
      console.log(
        `   isActive: ${r.isActive}  templateId: ${r.templateId ?? "NULL"}  connectionId: ${r.connectionId ?? "NULL"}`,
      );
      console.log(
        `   integrations: direct targetWebsiteId=${d.n_direct}  multi_dest distinct=${m.n_multi}  → ${totalLinked}`,
      );
      console.log(
        `   orders (dispatch pipe): last 7d count=${o7.n}  lastOrderAt=${o7.lastAt ? new Date(o7.lastAt).toISOString() : "—"}`,
      );
      console.log(
        `   orders: last 30d count=${o30.n}  last30d lastOrderAt=${o30.lastAt ? new Date(o30.lastAt).toISOString() : "—"}`,
      );
      if (integRows.length) {
        for (const ir of integRows) {
          const pf =
            ir.pageId && ir.formId
              ? `page=${ir.pageId} form=${ir.formId}`
              : "—";
          console.log(
            `      integ id=${ir.id} type=${ir.type} name=${(ir.name || "").slice(0, 40)}… active=${ir.isActive} ${pf}`,
          );
        }
      } else {
        console.log("      (no integration rows point at this target)");
      }
      console.log("");
    }

    console.log(
      "Total target rows in report: " + rows.length + "\n" + "═".repeat(76) + "\n",
    );
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

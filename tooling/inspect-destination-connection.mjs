import mysql from "mysql2/promise";

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id <= 0) {
  console.error("Usage: node inspect-destination-connection.mjs <target_website_id>");
  process.exit(1);
}
const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);
try {
  const [rows] = await conn.query(
    `SELECT tw.id, tw.name, tw.userId, tw.appKey, tw.templateId, tw.connectionId, tw.templateType,
            tw.url, dt.name AS template_name, c.id AS conn_id, c.type AS conn_type, c.status AS conn_status
     FROM target_websites tw
     LEFT JOIN destination_templates dt ON dt.id = tw.templateId
     LEFT JOIN connections c ON c.id = tw.connectionId
     WHERE tw.id = ?`,
    [id],
  );
  if (rows.length === 0) { console.error("not found"); process.exit(2); }
  console.log("Destination:", rows[0]);

  console.log("\nAvailable connections for user:");
  const [conns] = await conn.query(
    `SELECT id, type, name, status FROM connections WHERE userId = ? ORDER BY id`,
    [rows[0].userId],
  );
  for (const c of conns) console.log(" ", c);
} finally {
  await conn.end();
}

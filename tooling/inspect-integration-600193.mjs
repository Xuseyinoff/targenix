import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);
try {
  const [intg] = await conn.query(
    `SELECT id, userId, name, type, pageId, formId, targetWebsiteId, facebookAccountId
     FROM integrations WHERE id = 600193`,
  );
  console.log("integration 600193:", intg[0]);

  const userId = intg[0].userId;
  console.log("\nintegration owner userId:", userId);

  const [tw] = await conn.query(
    `SELECT id, userId, name, appKey, templateId, connectionId FROM target_websites WHERE id = 60050`,
  );
  console.log("\ntarget_website 60050:", tw[0]);
  console.log("destination owner userId:", tw[0].userId);

  console.log("\nMATCH:", tw[0].userId === userId ? "YES — same owner" : "NO — DIFFERENT OWNERS");

  console.log("\nintegration_destinations rows for integration 600193:");
  const [id_rows] = await conn.query(
    `SELECT * FROM integration_destinations WHERE integrationId = 600193`,
  );
  for (const r of id_rows) console.log(" ", r);

  console.log("\nconnection 29 details:");
  const [cn] = await conn.query(
    `SELECT id, userId, type, appKey, status FROM connections WHERE id = 29`,
  );
  console.log(" ", cn[0]);
} finally {
  await conn.end();
}

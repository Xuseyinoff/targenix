import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
const conn = await mysql.createConnection(url);

// Search by phone number
const [rows] = await conn.execute(`
  SELECT 
    l.id, l.userId, l.leadgenId, l.pageId, l.formId,
    l.fullName, l.phone, l.email,
    l.dataStatus, l.deliveryStatus,
    l.createdAt, l.updatedAt,
    u.name AS userName, u.email AS userEmail
  FROM leads l
  LEFT JOIN users u ON u.id = l.userId
  WHERE l.phone LIKE '%913006881%'
     OR l.fullName LIKE '%Ismoil%'
  ORDER BY l.createdAt DESC
  LIMIT 10
`);

console.log("=== LEADS FOUND ===");
for (const r of rows) {
  console.log(JSON.stringify(r, null, 2));
}

// Also check integrations for this user
if (rows.length > 0) {
  const userId = rows[0].userId;
  const [integrations] = await conn.execute(`
    SELECT i.id, i.userId, i.name, i.type, i.pageId, i.formId, i.targetWebsiteId,
           tw.name AS targetName, tw.url AS targetUrl
    FROM integrations i
    LEFT JOIN target_websites tw ON tw.id = i.targetWebsiteId
    WHERE i.userId = ?
  `, [userId]);
  
  console.log("\n=== USER INTEGRATIONS ===");
  for (const i of integrations) {
    console.log(JSON.stringify(i, null, 2));
  }

  // Check user info
  const [userInfo] = await conn.execute(`
    SELECT id, name, email, role, telegramChatId, telegramUsername
    FROM users WHERE id = ?
  `, [userId]);
  console.log("\n=== USER INFO ===");
  console.log(JSON.stringify(userInfo[0], null, 2));
}

await conn.end();

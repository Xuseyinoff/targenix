import mysql from "mysql2/promise";

const c = await mysql.createConnection(process.env.MYSQL_PUBLIC_URL);

const q = async (sql, params = []) => {
  const [rows] = await c.execute(sql, params);
  return rows;
};

console.log("\n=== Production destinations overview ===\n");

// 1. By templateType
const byType = await q(`
  SELECT templateType, COUNT(*) AS n, SUM(isActive) AS active
  FROM target_websites
  GROUP BY templateType
  ORDER BY n DESC
`);
console.log("1. target_websites by type:");
console.table(byType);

// 2. Total destinations
const total = await q(`SELECT COUNT(*) AS n FROM target_websites`);
console.log(`\n2. Total target_websites: ${total[0].n}`);

// 3. Destinations using admin templates (templateId IS NOT NULL)
const tplUsage = await q(`
  SELECT
    SUM(CASE WHEN templateId IS NOT NULL THEN 1 ELSE 0 END) AS from_template,
    SUM(CASE WHEN templateId IS NULL     THEN 1 ELSE 0 END) AS custom
  FROM target_websites
`);
console.log(`\n3. Template vs custom:`);
console.log(`   From admin template: ${tplUsage[0].from_template}`);
console.log(`   Custom (user-built): ${tplUsage[0].custom}`);

// 4. Destination templates (admin-created)
const tplTable = await q(`SHOW TABLES LIKE 'destination_templates'`);
if (tplTable.length) {
  const tpls = await q(`
    SELECT category, COUNT(*) AS n, GROUP_CONCAT(name SEPARATOR ', ') AS names
    FROM destination_templates
    GROUP BY category
    ORDER BY n DESC
  `);
  console.log(`\n4. destination_templates (admin catalog):`);
  console.table(tpls);
}

// 5. Recent activity — orders per destination type (last 30 days, via integrations join)
const recent = await q(`
  SELECT tw.templateType, COUNT(*) AS orders_count
  FROM orders o
  JOIN integrations i ON i.id = o.integrationId
  JOIN target_websites tw ON JSON_UNQUOTE(JSON_EXTRACT(i.config, '$.targetWebsiteId')) = tw.id
  WHERE o.createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  GROUP BY tw.templateType
  ORDER BY orders_count DESC
`).catch((err) => {
  console.log(`   (skipped: ${err.sqlMessage})`);
  return [];
});
if (recent.length) {
  console.log(`\n5. Orders last 30 days by destination type:`);
  console.table(recent);
}

// 6. Google accounts & Telegram details
const gAcc = await q(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN refreshToken IS NOT NULL THEN 1 ELSE 0 END) AS with_refresh
  FROM google_accounts
`);
console.log(`\n6. Google accounts: ${gAcc[0].total} total, ${gAcc[0].with_refresh} with refresh token`);

// 7. Users using each destination type (concurrent)
const users = await q(`
  SELECT templateType, COUNT(DISTINCT userId) AS users
  FROM target_websites
  GROUP BY templateType
  ORDER BY users DESC
`);
console.log(`\n7. Users per destination type:`);
console.table(users);

console.log("");
await c.end();

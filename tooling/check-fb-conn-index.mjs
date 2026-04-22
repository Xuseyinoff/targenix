import mysql from "mysql2/promise";

const candidates = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL];
const url = candidates.find((u) => u?.startsWith("mysql://") && !u.includes("railway.internal"));
if (!url) { console.error("No DB URL"); process.exit(1); }

const conn = await mysql.createConnection(url);

const [idx] = await conn.query(
  `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
     FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'facebook_connections'
    ORDER BY INDEX_NAME, SEQ_IN_INDEX`
);
console.log("facebook_connections indexes:");
console.table(idx);

const [dups] = await conn.query(
  `SELECT userId, pageId, COUNT(*) AS rows_cnt, COUNT(DISTINCT facebookAccountId) AS accounts_cnt
     FROM facebook_connections
    GROUP BY userId, pageId
   HAVING rows_cnt > 1`
);
console.log("\nExisting (userId, pageId) groups with >1 rows:");
console.table(dups);

const [sharedPages] = await conn.query(
  `SELECT pageId, COUNT(DISTINCT userId) AS tenants
     FROM facebook_connections
    WHERE isActive = 1
    GROUP BY pageId
   HAVING tenants > 1
    ORDER BY tenants DESC`
);
console.log("\nActive pages shared by >1 Targenix user:");
console.table(sharedPages);

await conn.end();

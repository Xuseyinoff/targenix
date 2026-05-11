import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../server/db";
const db = await getDb();
if (!db) process.exit(1);
const r = (await db.execute(sql`
  SELECT
    o.id,
    o.errorType,
    LEFT(JSON_UNQUOTE(JSON_EXTRACT(o.responseData, '$.error')), 200) AS errBody,
    l.phone,
    o.lastAttemptAt
  FROM orders o
  LEFT JOIN leads l ON l.id = o.leadId
  WHERE JSON_EXTRACT(o.responseData, '$') LIKE '%customer_phone%'
    OR JSON_EXTRACT(o.responseData, '$') LIKE '%422%'
  ORDER BY o.lastAttemptAt DESC
  LIMIT 10
`)) as any;
for (const row of r[0]) console.log(JSON.stringify(row));
await closeDb();

import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  const [totalRow] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM webhook_events"
  );
  console.log(`Total webhook_events: ${totalRow[0]!.n}`);

  const [dupeGroupsRow] = await conn.query<mysql.RowDataPacket[]>(`
    SELECT COUNT(*) AS dupe_signatures, SUM(n) AS dupe_rows, SUM(n - 1) AS rows_to_delete
    FROM (
      SELECT signature, COUNT(*) AS n
      FROM webhook_events
      WHERE signature IS NOT NULL
      GROUP BY signature
      HAVING n > 1
    ) t
  `);
  const stats = dupeGroupsRow[0]!;
  console.log(`Duplicate signature groups: ${stats.dupe_signatures}`);
  console.log(`Total duplicate rows: ${stats.dupe_rows}`);
  console.log(`Rows to delete (keep oldest per group): ${stats.rows_to_delete}`);

  // Sample: time span of duplicates
  const [span] = await conn.query<mysql.RowDataPacket[]>(`
    SELECT MIN(createdAt) AS first_seen, MAX(createdAt) AS last_seen
    FROM webhook_events
    WHERE signature IN (
      SELECT signature FROM (
        SELECT signature FROM webhook_events WHERE signature IS NOT NULL
        GROUP BY signature HAVING COUNT(*) > 1
      ) t
    )
  `);
  console.log(`Time span: ${span[0]!.first_seen} to ${span[0]!.last_seen}`);

  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

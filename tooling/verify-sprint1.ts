import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  console.log("=== Sprint 1 verification ===\n");

  // 1. Unique index exists
  const [idx] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT INDEX_NAME, NON_UNIQUE FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhook_events' AND INDEX_NAME = 'uniq_webhook_events_signature'"
  );
  console.log("1.1 Unique index on signature:", idx.length > 0 ? "✓ EXISTS" : "✗ MISSING");

  // 2. Latest webhook_events rows
  const [latest] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, eventType, LEFT(signature, 30) AS sig, processed, createdAt FROM webhook_events ORDER BY id DESC LIMIT 5"
  );
  console.log("\n1.2 Latest 5 webhook_events:");
  for (const r of latest) {
    console.log(`   id=${r.id} type=${r.eventType} sig=${r.sig}... processed=${r.processed} ${r.createdAt}`);
  }

  // 3. Total duplicates remaining
  const [dupes] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM (SELECT signature FROM webhook_events WHERE signature IS NOT NULL GROUP BY signature HAVING COUNT(*) > 1) t"
  );
  console.log(`\n1.3 Duplicate signatures remaining: ${dupes[0]!.n} (expected: 0)`);

  // 4. circuitBreakerService.ts deleted
  const fs = await import("fs");
  const cbExists = fs.existsSync("server/services/circuitBreakerService.ts");
  console.log(`\n1.4 Circuit breaker file deleted: ${!cbExists ? "✓ DELETED" : "✗ STILL EXISTS"}`);

  await conn.end();
  console.log("\n=== Sprint 1 verification complete ===");
}
main().catch((e) => { console.error(e); process.exit(1); });

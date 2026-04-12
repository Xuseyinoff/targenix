/**
 * When production schema already includes 0026/0027 DDL but __drizzle_migrations
 * stopped at 0025, `drizzle-kit migrate` would re-run 0026 and fail on existing tables.
 * This inserts journal rows for 0026 and 0027 only if those timestamps are missing.
 */
import mysql from "mysql2/promise";

const ROWS = [
  // hashes match `crypto.createHash('sha256').update(fs.readFileSync(...))` (LF file contents)
  ["2c00e911b47b51447a2604cff5ba24e8ea48c58a12660b96cb1ce29be523b58c", 1775794761015],
  ["e0cf3b4a8bb7973738539220de87f24b524dcc89ad5d13cc5fbf5f63d62dd6eb", 1775934583037],
];

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) {
  console.error("Need mysql:// URL");
  process.exit(1);
}

async function main() {
  const conn = await mysql.createConnection(url);
  try {
    for (const [hash, created_at] of ROWS) {
      const [existing] = await conn.query(
        "SELECT id FROM `__drizzle_migrations` WHERE `created_at` = ? LIMIT 1",
        [created_at]
      );
      if (existing.length > 0) {
        console.log(`[backfill] created_at=${created_at} already present, skip`);
        continue;
      }
      await conn.query(
        "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
        [hash, created_at]
      );
      console.log(`[backfill] inserted created_at=${created_at}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

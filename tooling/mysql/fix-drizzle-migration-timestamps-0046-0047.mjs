/**
 * Drizzle MySQL migrator (drizzle-orm) only compares max(created_at) to each migration's
 * journal `when` — it does not skip by hash. If 0046/0047 were backfilled with wrong
 * created_at, 0046+ re-run. Align created_at to meta/_journal.json `when` for 0046/0047.
 */
import mysql from "mysql2/promise";

const FIXES = [
  ["e6f17fe58bac77431b6deb413e32d39315f21b8efefaabca909c1eab85fcc1bd", 1777161600000],
  ["ae5a75cb4d636633db7a0ca7d78b4ac2be62ac3682d588d82a23105342d82574", 1777248000000],
];

const u = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!u?.startsWith("mysql://")) {
  console.error("Need mysql:// URL");
  process.exit(1);
}

const c = await mysql.createConnection(u);
try {
  for (const [hash, when] of FIXES) {
    const [r] = await c.query(
      "UPDATE `__drizzle_migrations` SET `created_at` = ? WHERE `hash` = ?",
      [when, hash]
    );
    console.log(`[fix] hash=${hash.slice(0, 8)}… created_at=${when} affectedRows=${r.affectedRows}`);
  }
} finally {
  await c.end();
}

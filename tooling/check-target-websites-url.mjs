/**
 * One-off: print target_websites.url nullability (use: railway run node tooling/check-target-websites-url.mjs)
 *
 * Railway CLI on Windows may inject env keys with a trailing \\n (e.g. "MYSQL_PUBLIC_URL\\n").
 */
import mysql from "mysql2/promise";

function pickMysqlUrl() {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
  ];
  for (const [k, v] of Object.entries(process.env)) {
    const name = k.replace(/\r/g, "").trim();
    if (
      (name === "MYSQL_PUBLIC_URL" || name === "MYSQL_URL") &&
      typeof v === "string" &&
      v.trim().startsWith("mysql://")
    ) {
      candidates.push(v.trim());
    }
  }
  return candidates.find((u) => typeof u === "string" && u.startsWith("mysql://"));
}

const url = pickMysqlUrl();

if (!url) {
  console.error("No MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

// --- Migration table (Drizzle MySQL = __drizzle_migrations; some docs say drizzle_migrations)
for (const table of ["__drizzle_migrations", "drizzle_migrations"]) {
  const [[{ n }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [table]
  );
  if (!n) continue;
  console.log(`\n--- Recent rows: ${table} ---`);
  const [migs] = await conn.query(
    `SELECT * FROM \`${table}\` ORDER BY created_at DESC LIMIT 8`
  );
  console.log(JSON.stringify(migs, null, 2));
}

console.log("\n--- target_websites.url ---");
const [rows] = await conn.query(
  "SHOW COLUMNS FROM target_websites LIKE 'url'"
);
console.log(JSON.stringify(rows, null, 2));
const col = rows[0];
const nullable = col?.Null ?? col?.NULL;
console.log(
  "\nurl.Null:",
  nullable,
  "=>",
  nullable === "YES" ? "OK (nullable) — migration 0039 effect present" : "NO — 0039 NOT applied (or run ALTER ... url NULL)"
);

await conn.end();

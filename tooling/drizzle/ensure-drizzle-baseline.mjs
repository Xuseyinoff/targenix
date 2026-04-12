/**
 * Production DBs created without Drizzle migrate often have an empty __drizzle_migrations
 * table while all tables already exist — then `drizzle-kit migrate` replays 0000+ and fails.
 *
 * This script inserts a single baseline row (created_at = last pre-0028 journal `when`)
 * only when the table is empty, so the next `drizzle-kit migrate` applies 0028+ only.
 */
import mysql from "mysql2/promise";

const BASELINE_CREATED_AT = 1775934583037; // meta/_journal.json → 0027_flippant_garia.when
const BASELINE_HASH = "manual_baseline_before_0028";

function resolveUrl() {
  const u =
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL;
  if (!u || !String(u).startsWith("mysql://")) {
    console.error("Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL (mysql://…).");
    process.exit(1);
  }
  return u;
}

async function main() {
  const conn = await mysql.createConnection(resolveUrl());
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
        \`id\` serial primary key,
        \`hash\` text not null,
        \`created_at\` bigint
      )
    `);
    const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations`");
    const count = Number(n);
    if (count > 0) {
      console.log(`[ensure-drizzle-baseline] __drizzle_migrations already has ${count} row(s); skipping insert.`);
      return;
    }
    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [BASELINE_HASH, BASELINE_CREATED_AT]
    );
    console.log(
      `[ensure-drizzle-baseline] Inserted baseline row (created_at=${BASELINE_CREATED_AT}). Run: pnpm exec drizzle-kit migrate`
    );
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

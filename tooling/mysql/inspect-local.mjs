import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const conn = await mysql.createConnection(url);
  const [[dbRow]] = await conn.query("SELECT DATABASE() as db");
  console.log("DB:", dbRow?.db);

  const [tables] = await conn.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"
  );
  const tableNames = tables.map((r) => r.table_name ?? r.TABLE_NAME ?? r.Table_name ?? r[0]).filter(Boolean);
  console.log("Tables:", tableNames);

  for (const table of ["users", "target_websites", "__drizzle_migrations"]) {
    const [exists] = await conn.query(
      "SELECT COUNT(*) as n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",
      [table]
    );
    if (!exists?.[0]?.n) {
      console.log(`\n${table}: MISSING`);
      continue;
    }
    const [cols] = await conn.query(
      "SELECT column_name, column_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",
      [table]
    );
    const colNames = cols.map((c) => c.column_name ?? c.COLUMN_NAME ?? c.Column_name ?? c[0]).filter(Boolean);
    console.log(`\n${table}: columns=`, colNames);
  }

  await conn.end();
}

main().catch((e) => {
  console.error("ERROR:", e?.code ?? e?.name, e?.message ?? String(e));
  process.exit(1);
});


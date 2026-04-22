import "dotenv/config";
import mysql from "mysql2/promise";

async function ensureColumn(conn, table, column, ddl) {
  const [rows] = await conn.query(
    "SELECT COUNT(*) as n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?",
    [table, column]
  );
  const n = rows?.[0]?.n ?? rows?.[0]?.N ?? 0;
  if (Number(n) > 0) {
    console.log(`OK: ${table}.${column} exists`);
    return;
  }
  console.log(`ADD: ${table}.${column}`);
  await conn.query(`ALTER TABLE ${table} ${ddl}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const conn = await mysql.createConnection(url);
  const [[dbRow]] = await conn.query("SELECT DATABASE() as db");
  console.log("DB:", dbRow?.db);

  // Fix 1: target_websites.telegramChatId (used by UI when saving destinations)
  await ensureColumn(
    conn,
    "target_websites",
    "telegramChatId",
    "ADD COLUMN telegramChatId varchar(64) NULL"
  );

  await conn.end();
}

main().catch((e) => {
  console.error("ERROR:", e?.code ?? e?.name, e?.message ?? String(e));
  process.exit(1);
});


import "dotenv/config";
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  const [trx] = await conn.query<mysql.RowDataPacket[]>(`
    SELECT trx_id, trx_state, trx_started, trx_mysql_thread_id, trx_query
    FROM information_schema.INNODB_TRX
  `);
  console.log(`Active InnoDB transactions: ${trx.length}`);
  for (const t of trx) {
    console.log(`  trx=${t.trx_id} state=${t.trx_state} started=${t.trx_started} thread=${t.trx_mysql_thread_id} query=${(t.trx_query ?? "").slice(0, 100)}`);
  }

  // Kill any transaction older than 30 seconds
  let killed = 0;
  for (const t of trx) {
    const ageSec = (Date.now() - new Date(t.trx_started as string).getTime()) / 1000;
    if (ageSec > 30) {
      try {
        await conn.query(`KILL ${t.trx_mysql_thread_id}`);
        console.log(`  Killed thread ${t.trx_mysql_thread_id} (age ${ageSec.toFixed(0)}s)`);
        killed++;
      } catch (err) {
        console.log(`  Could not kill thread ${t.trx_mysql_thread_id}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`Killed ${killed} stale transactions.`);

  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

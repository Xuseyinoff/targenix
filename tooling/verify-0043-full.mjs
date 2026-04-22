import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.MYSQL_PUBLIC_URL?.trim();
if (!url) { console.error("No MYSQL_PUBLIC_URL"); process.exit(1); }

const conn = await mysql.createConnection(url);

const q = async (sql, params = []) => {
  const [rows] = await conn.execute(sql, params);
  return rows;
};

const schema = "railway";

const tbl       = await q(`SELECT COUNT(*) AS n FROM information_schema.tables
                           WHERE table_schema=? AND table_name='connections'`, [schema]);
const col       = await q(`SELECT COUNT(*) AS n FROM information_schema.columns
                           WHERE table_schema=? AND table_name='target_websites'
                             AND column_name='connectionId'`, [schema]);
const idxTw     = await q(`SELECT COUNT(*) AS n FROM information_schema.statistics
                           WHERE table_schema=? AND table_name='target_websites'
                             AND index_name='idx_target_websites_connection_id'`, [schema]);
const idxConnU  = await q(`SELECT COUNT(*) AS n FROM information_schema.statistics
                           WHERE table_schema=? AND table_name='connections'
                             AND index_name='idx_connections_user_id'`, [schema]);
const idxConnUT = await q(`SELECT COUNT(*) AS n FROM information_schema.statistics
                           WHERE table_schema=? AND table_name='connections'
                             AND index_name='idx_connections_user_type'`, [schema]);
const fkTw      = await q(`SELECT COUNT(*) AS n FROM information_schema.table_constraints
                           WHERE table_schema=? AND constraint_name='fk_target_websites_connection'`, [schema]);
const fkConn    = await q(`SELECT COUNT(*) AS n FROM information_schema.table_constraints
                           WHERE table_schema=? AND constraint_name='fk_connections_google_account'`, [schema]);

const check = (label, n) => console.log(`${n ? "✅" : "❌"}  ${label}`);

console.log("\n=== Migration 0043 diagnostic (production) ===");
check("1. connections table                          ", tbl[0].n);
check("2. target_websites.connectionId column        ", col[0].n);
check("3. index idx_target_websites_connection_id    ", idxTw[0].n);
check("4. index idx_connections_user_id              ", idxConnU[0].n);
check("5. index idx_connections_user_type            ", idxConnUT[0].n);
check("6. FK fk_target_websites_connection           ", fkTw[0].n);
check("7. FK fk_connections_google_account           ", fkConn[0].n);
console.log("");

await conn.end();

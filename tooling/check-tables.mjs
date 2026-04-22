import mysql from "mysql2/promise";
const c = await mysql.createConnection(process.env.MYSQL_PUBLIC_URL);
const [r1] = await c.execute("SHOW TABLES LIKE 'google_accounts'");
const [r2] = await c.execute("SHOW TABLES LIKE 'target_websites'");
console.log("google_accounts:", r1.length ? "EXISTS" : "MISSING");
console.log("target_websites:", r2.length ? "EXISTS" : "MISSING");
await c.end();

import mysql from "mysql2/promise";
const cn = await mysql.createConnection(process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL);
const [cols] = await cn.query("SHOW COLUMNS FROM orders");
console.log(cols.map(c => c.Field).join(", "));
await cn.end();

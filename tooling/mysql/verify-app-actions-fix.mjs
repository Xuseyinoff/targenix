import mysql from "mysql2/promise";
// Try both URLs
const urls = [
  ["MYSQL_URL", process.env.MYSQL_URL],
  ["MYSQL_PUBLIC_URL", process.env.MYSQL_PUBLIC_URL],
  ["DATABASE_URL", process.env.DATABASE_URL],
].filter(([, u]) => u?.startsWith("mysql://"));

for (const [name, url] of urls) {
  const cn = await mysql.createConnection(url);
  const [cols] = await cn.query("SHOW COLUMNS FROM app_actions");
  const names = cols.map(c => c.Field);
  const hasNew = ["schemaVersion","inputSchema","outputSchema","uiSchema"].every(c => names.includes(c));
  console.log(`${name}: columns OK=${hasNew}`, names.join(", "));
  await cn.end();
}

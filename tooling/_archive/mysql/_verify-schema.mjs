import mysql from "mysql2/promise";
const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
const cn = await mysql.createConnection(url);
try {
  console.log("Connected:", url.replace(/:[^@]+@/, ":****@"));
  console.log();

  console.log("destination_templates.appKey present?");
  const [cols] = await cn.query(
    `SHOW COLUMNS FROM destination_templates LIKE 'appKey'`,
  );
  console.log(cols.length > 0 ? "  ✓ YES" : "  ✗ NO");

  console.log();
  console.log("connections.appKey present?");
  const [cols2] = await cn.query(
    `SHOW COLUMNS FROM connections LIKE 'appKey'`,
  );
  console.log(cols2.length > 0 ? "  ✓ YES" : "  ✗ NO");

  console.log();
  console.log("connection_app_specs seed rows:");
  const [specs] = await cn.query(
    `SELECT id, appKey, displayName, authType FROM connection_app_specs ORDER BY id`,
  );
  for (const s of specs)
    console.log(`  id=${s.id} appKey=${s.appKey} type=${s.authType} "${s.displayName}"`);

  console.log();
  console.log("destination_templates appKey values:");
  const [tpl] = await cn.query(
    `SELECT id, name, appKey, isActive FROM destination_templates ORDER BY id`,
  );
  for (const t of tpl)
    console.log(
      `  id=${t.id} appKey=${t.appKey ?? "∅"} active=${t.isActive} "${t.name}"`,
    );

  console.log();
  console.log("Last migration journal rows:");
  const [mig] = await cn.query(
    `SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 5`,
  );
  for (const m of mig)
    console.log(
      `  id=${m.id} hash=${m.hash.slice(0, 16)}… created=${new Date(Number(m.created_at)).toISOString()}`,
    );
} finally {
  await cn.end();
}

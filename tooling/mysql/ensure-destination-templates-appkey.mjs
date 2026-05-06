/**
 * Lokal/dev: destination_templates.appKey + NULL qatorlarni toʻldirish + apps jadvaliga yo‘l.
 * drizzle-kit migrate ba’zan jurnal/DB mos kelmasa; push interaktiv — shuning uchun bu skript.
 *
 * Ketma-ketlik (loyiha ildizidan, .env da mysql:// URL):
 *   1. node tooling/mysql/ensure-destination-templates-appkey.mjs
 *   2. node tooling/mysql/admin-seed-missing-apps.mjs
 *   3. PORT=3000 pnpm dev   (yoki default 3000)
 */
import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

async function main() {
  const url = getMysqlUrl();
  if (!url) {
    console.error("Kerak: mysql:// (DATABASE_URL / MYSQL_URL / MYSQL_PUBLIC_URL)");
    process.exit(1);
  }

  const cn = await mysql.createConnection(url);
  try {
    const [[{ n }]] = await cn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'destination_templates' AND COLUMN_NAME = 'appKey'`,
    );

    if (Number(n) === 0) {
      console.log("destination_templates ga appKey ustuni qoʻshilyapti...");
      await cn.query(`
        ALTER TABLE \`destination_templates\`
          ADD COLUMN \`appKey\` VARCHAR(64) NULL,
          ADD INDEX \`idx_destination_templates_appKey\` (\`appKey\`)
      `);
      console.log("✓ appKey ustuni qoʻshildi.");
    } else {
      console.log("destination_templates.appKey ustuni mavjud.");
    }

    const [upd] = await cn.query(`
      UPDATE \`destination_templates\`
         SET \`appKey\` = CASE
           WHEN \`endpointUrl\` LIKE '%mgoods.uz%'   THEN 'mgoods'
           WHEN \`endpointUrl\` LIKE '%100k.uz%'    THEN '100k'
           WHEN \`endpointUrl\` LIKE '%sotuvchi.com%' THEN 'sotuvchi'
           WHEN \`endpointUrl\` LIKE '%inbaza.uz%'    THEN 'inbaza'
           WHEN \`endpointUrl\` LIKE '%alijahon.uz%'  THEN 'alijahon'
           WHEN LOWER(TRIM(\`name\`)) LIKE '%mycpa%'  THEN 'mgoods'
           ELSE \`appKey\`
         END
       WHERE (\`appKey\` IS NULL OR TRIM(\`appKey\`) = '')
    `);
    const changed = typeof upd?.affectedRows === "number" ? upd.affectedRows : 0;
    console.log(changed ? `✓ appKey toʻldirildi (${changed} qator).` : "— appKey backfill: yangilanadigan qator yoʻq.");

    console.log(
      "\nKeyingi qadam (apps jadvali/seed):\n  node tooling/mysql/admin-seed-missing-apps.mjs\n",
    );
  } finally {
    await cn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * One-time repair: if 0049 DDL + appKey backfill committed but the actionId UPDATE
 * failed (e.g. collation) before the migration row was recorded, run the fixed
 * actionId backfill and insert `__drizzle_migrations` for 0049.
 * Safe to re-run: no-op if journal row already exists.
 */
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) {
  console.error("Need mysql:// URL");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlFile = join(__dirname, "../../drizzle/0049_target_websites_appkey_actionid.sql");
const hash = createHash("sha256").update(readFileSync(sqlFile)).digest("hex");
const CREATED_AT = 1777401600000;

const actionIdUpdate = `
UPDATE \`target_websites\` \`tw\`
INNER JOIN \`destination_templates\` \`dt\` ON \`dt\`.\`id\` = \`tw\`.\`templateId\`
INNER JOIN \`app_actions\` \`aa\`
  ON BINARY \`aa\`.\`appKey\` = BINARY \`dt\`.\`appKey\`
  AND \`aa\`.\`actionKey\` = CONVERT(CONCAT('t', \`dt\`.\`id\`) USING utf8mb4) COLLATE utf8mb4_unicode_ci
SET \`tw\`.\`actionId\` = \`aa\`.\`id\`
WHERE \`tw\`.\`actionId\` IS NULL
`.trim();

const c = await mysql.createConnection(url);
try {
  const [existing] = await c.query(
    "SELECT `id` FROM `__drizzle_migrations` WHERE `created_at` = ? LIMIT 1",
    [CREATED_AT],
  );
  if (existing.length) {
    console.log("[apply-0049] __drizzle_migrations already has 0049 — skipping");
  } else {
    const [r] = await c.query(actionIdUpdate);
    console.log("[apply-0049] actionId UPDATE rows matched:", r.affectedRows);
    await c.query("INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)", [
      hash,
      CREATED_AT,
    ]);
    console.log("[apply-0049] inserted __drizzle_migrations", { hash, created_at: CREATED_AT });
  }
} finally {
  await c.end();
}

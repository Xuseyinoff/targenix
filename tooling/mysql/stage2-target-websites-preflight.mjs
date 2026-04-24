/**
 * Stage 2 — pre/post for `target_websites.appKey` + `actionId` (migration 0049).
 *
 *   node tooling/mysql/stage2-target-websites-preflight.mjs pre-audit
 *   node tooling/mysql/stage2-target-websites-preflight.mjs verify
 *   node tooling/mysql/stage2-target-websites-preflight.mjs sample
 */
import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
}

async function preAudit(conn) {
  const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM `target_websites`");
  const [[{ missing_template }]] = await conn.query(
    "SELECT COUNT(*) AS missing_template FROM `target_websites` WHERE `templateId` IS NULL",
  );
  const [[{ orphan_templates }]] = await conn.query(
    `SELECT COUNT(*) AS orphan_templates
     FROM \`target_websites\` \`tw\`
     LEFT JOIN \`destination_templates\` \`dt\` ON \`dt\`.\`id\` = \`tw\`.\`templateId\`
     WHERE \`tw\`.\`templateId\` IS NOT NULL AND \`dt\`.\`id\` IS NULL`,
  );
  const [[{ template_missing_appkey }]] = await conn.query(
    `SELECT COUNT(*) AS template_missing_appkey
     FROM \`target_websites\` \`tw\`
     INNER JOIN \`destination_templates\` \`dt\` ON \`dt\`.\`id\` = \`tw\`.\`templateId\`
     WHERE \`dt\`.\`appKey\` IS NULL OR TRIM(\`dt\`.\`appKey\`) = ''`,
  );
  const stop =
    Number(orphan_templates) > 0
      ? "STOP — orphan_templates > 0 (fix FK references first)"
      : Number(template_missing_appkey) > 0
        ? "STOP — destination_templates with NULL/empty appKey for linked target_websites"
        : "OK to run 0049";

  console.log(
    JSON.stringify(
      {
        step: "pre-audit",
        total: Number(total),
        missing_template: Number(missing_template),
        orphan_templates: Number(orphan_templates),
        template_missing_appkey: Number(template_missing_appkey),
        status: stop.startsWith("STOP") ? "NOT_SAFE" : "READY",
        action: stop,
      },
      null,
      2,
    ),
  );
  if (Number(orphan_templates) > 0 || Number(template_missing_appkey) > 0) {
    process.exit(1);
  }
}

/** True if 0049 columns already exist. */
async function hasStage2Columns(conn) {
  const [[{ n }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'target_websites' AND COLUMN_NAME = 'appKey'",
  );
  return Number(n) > 0;
}

async function verify(conn) {
  if (!(await hasStage2Columns(conn))) {
    console.log(
      JSON.stringify(
        { step: "verify", error: "Columns appKey/actionId not present — run migration 0049 first" },
        null,
        2,
      ),
    );
    return;
  }
  const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM `target_websites`");
  const [[{ missing_template }]] = await conn.query(
    "SELECT COUNT(*) AS missing_template FROM `target_websites` WHERE `templateId` IS NULL",
  );
  const [[{ missing_appKey }]] = await conn.query(
    "SELECT COUNT(*) AS missing_appKey FROM `target_websites` " +
      "WHERE `templateId` IS NOT NULL AND `appKey` IS NULL",
  );
  const [[{ missing_actionId }]] = await conn.query(
    "SELECT COUNT(*) AS missing_actionId FROM `target_websites` " +
      "WHERE `templateId` IS NOT NULL AND `actionId` IS NULL",
  );
  const safe = Number(missing_appKey) === 0 && Number(missing_actionId) === 0;
  console.log(
    JSON.stringify(
      {
        step: "verify",
        total: Number(total),
        missing_template: Number(missing_template),
        missing_appKey: Number(missing_appKey),
        missing_actionId: Number(missing_actionId),
        status: safe ? "SAFE" : "NOT_SAFE",
      },
      null,
      2,
    ),
  );
}

async function sample(conn) {
  if (!(await hasStage2Columns(conn))) {
    console.log(JSON.stringify({ step: "sample", error: "Run migration 0049 first" }, null, 2));
    return;
  }
  const [rows] = await conn.query(
    "SELECT `id`, `templateId`, `appKey`, `actionId` FROM `target_websites` " +
      "ORDER BY `id` LIMIT 10",
  );
  console.log(JSON.stringify({ step: "sample", rows }, null, 2));
}

async function main() {
  const cmd = process.argv[2] || "pre-audit";
  const url = getMysqlUrl();
  if (!url) {
    console.error("No DATABASE_URL / MYSQL_URL / MYSQL_PUBLIC_URL");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    if (cmd === "verify") await verify(conn);
    else if (cmd === "sample") await sample(conn);
    else await preAudit(conn);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

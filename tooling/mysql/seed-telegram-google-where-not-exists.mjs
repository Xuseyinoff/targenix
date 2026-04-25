/**
 * Idempotent inserts using WHERE NOT EXISTS (no reliance on ON DUPLICATE / UNIQUE).
 * app_actions has NO `config` column in schema — use 0050 column set + empty JSON arrays.
 *
 * Usage: railway run node tooling/mysql/seed-telegram-google-where-not-exists.mjs
 */
import mysql from "mysql2/promise";

function pickMysqlUrl() {
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

const Q_AUDIT = `
SELECT appKey FROM apps WHERE appKey IN ('telegram','google-sheets') ORDER BY appKey
`;

const Q_INSERT_APPS_TG = `
INSERT INTO \`apps\` (
  \`appKey\`, \`displayName\`, \`category\`, \`authType\`, \`fields\`,
  \`oauthConfig\`, \`iconUrl\`, \`docsUrl\`, \`isActive\`
)
SELECT
  'telegram', 'Telegram', 'messaging', 'api_key',
  CAST('[{"key":"bot_token","label":"Bot Token","required":true,"sensitive":true}]' AS JSON),
  NULL, NULL, NULL, TRUE
WHERE NOT EXISTS (SELECT 1 FROM \`apps\` a WHERE a.\`appKey\` = 'telegram')
`;

const Q_INSERT_APPS_GS = `
INSERT INTO \`apps\` (
  \`appKey\`, \`displayName\`, \`category\`, \`authType\`, \`fields\`,
  \`oauthConfig\`, \`iconUrl\`, \`docsUrl\`, \`isActive\`
)
SELECT
  'google-sheets', 'Google Sheets', 'data', 'oauth2',
  CAST('[]' AS JSON),
  NULL, NULL, NULL, TRUE
WHERE NOT EXISTS (SELECT 1 FROM \`apps\` a WHERE a.\`appKey\` = 'google-sheets')
`;

const Q_INSERT_ACT_TG = `
INSERT INTO \`app_actions\` (
  \`appKey\`, \`actionKey\`, \`name\`, \`endpointUrl\`, \`method\`, \`contentType\`,
  \`bodyFields\`, \`userFields\`, \`variableFields\`, \`autoMappedFields\`,
  \`isDefault\`, \`isActive\`
)
SELECT
  'telegram', 'send_message', 'Send Message', '', 'POST', NULL,
  CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON),
  TRUE, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM \`app_actions\` x
  WHERE x.\`appKey\` = 'telegram' AND x.\`actionKey\` = 'send_message'
)
`;

const Q_INSERT_ACT_GS = `
INSERT INTO \`app_actions\` (
  \`appKey\`, \`actionKey\`, \`name\`, \`endpointUrl\`, \`method\`, \`contentType\`,
  \`bodyFields\`, \`userFields\`, \`variableFields\`, \`autoMappedFields\`,
  \`isDefault\`, \`isActive\`
)
SELECT
  'google-sheets', 'append_row', 'Append Row', '', 'POST', NULL,
  CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON),
  TRUE, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM \`app_actions\` x
  WHERE x.\`appKey\` = 'google-sheets' AND x.\`actionKey\` = 'append_row'
)
`;

const Q_DUP_APPS = `
SELECT appKey, COUNT(*) AS c FROM apps
WHERE appKey IN ('telegram','google-sheets')
GROUP BY appKey
`;

const Q_DUP_ACT = `
SELECT appKey, actionKey, COUNT(*) AS c FROM app_actions
GROUP BY appKey, actionKey
HAVING COUNT(*) > 1
`;

function ar(r) {
  if (r && typeof r === "object" && "affectedRows" in r) return r.affectedRows;
  return 0;
}

async function main() {
  const url = pickMysqlUrl();
  if (!url) {
    console.error(JSON.stringify({ ok: false, error: "No mysql:// URL" }));
    process.exit(2);
  }

  const conn = await mysql.createConnection(url);

  const [auditBefore] = await conn.query(Q_AUDIT);

  const [r1] = await conn.query(Q_INSERT_APPS_TG);
  const [r2] = await conn.query(Q_INSERT_APPS_GS);
  const [r3] = await conn.query(Q_INSERT_ACT_TG);
  const [r4] = await conn.query(Q_INSERT_ACT_GS);

  const [auditAfter] = await conn.query(Q_AUDIT);
  const [verify] = await conn.query(`
    SELECT appKey, actionKey FROM app_actions
    WHERE appKey IN ('telegram','google-sheets') ORDER BY appKey, actionKey
  `);
  const [dupApps] = await conn.query(Q_DUP_APPS);
  const [dupAct] = await conn.query(Q_DUP_ACT);

  await conn.end();

  const out = {
    ok: true,
    note: "app_actions has no `config` column in this schema; metadata lives in app code (0050-compatible rows).",
    auditBefore,
    insertedRows: {
      apps_telegram: ar(r1),
      apps_google_sheets: ar(r2),
      app_actions_telegram: ar(r3),
      app_actions_google: ar(r4),
    },
    auditAfter,
    app_actions_verify: verify,
    duplicateCheck: { apps: dupApps, app_actions_duplicates_gt1: dupAct },
  };

  console.log(JSON.stringify(out, null, 2));

  const dups = Array.isArray(dupAct) && dupAct.length > 0;
  if (dups) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

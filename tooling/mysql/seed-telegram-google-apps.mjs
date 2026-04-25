/**
 * Idempotent: upserts telegram + google-sheets into apps + app_actions
 * (matches drizzle/0050_telegram_google_sheets_apps.sql).
 *
 * Usage: railway run node tooling/mysql/seed-telegram-google-apps.mjs
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

const UPSERT_APPS = `
INSERT INTO \`apps\` (
  \`appKey\`, \`displayName\`, \`category\`, \`authType\`, \`fields\`,
  \`oauthConfig\`, \`iconUrl\`, \`docsUrl\`, \`isActive\`
) VALUES
(
  'telegram',
  'Telegram',
  'messaging',
  'api_key',
  CAST('[{"key":"bot_token","label":"Bot Token","required":true,"sensitive":true}]' AS JSON),
  NULL, NULL, NULL, TRUE
),
(
  'google-sheets',
  'Google Sheets',
  'data',
  'oauth2',
  CAST('[]' AS JSON),
  NULL, NULL, NULL, TRUE
)
ON DUPLICATE KEY UPDATE
  \`displayName\` = VALUES(\`displayName\`),
  \`category\` = VALUES(\`category\`),
  \`authType\` = VALUES(\`authType\`),
  \`fields\` = VALUES(\`fields\`),
  \`isActive\` = VALUES(\`isActive\`)
`;

const UPSERT_ACTIONS = `
INSERT INTO \`app_actions\` (
  \`appKey\`, \`actionKey\`, \`name\`, \`endpointUrl\`, \`method\`, \`contentType\`,
  \`bodyFields\`, \`userFields\`, \`variableFields\`, \`autoMappedFields\`,
  \`isDefault\`, \`isActive\`
) VALUES
(
  'telegram', 'send_message', 'Send Message', '', 'POST', NULL,
  CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON),
  TRUE, TRUE
),
(
  'google-sheets', 'append_row', 'Append Row', '', 'POST', NULL,
  CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON),
  TRUE, TRUE
)
ON DUPLICATE KEY UPDATE
  \`name\` = VALUES(\`name\`),
  \`endpointUrl\` = VALUES(\`endpointUrl\`),
  \`method\` = VALUES(\`method\`),
  \`isActive\` = VALUES(\`isActive\`)
`;

const BACKFILL_TW = `
UPDATE \`target_websites\`
SET \`appKey\` = 'telegram'
WHERE \`templateType\` = 'telegram'
  AND (\`appKey\` IS NULL OR \`appKey\` = '')
`;

const BACKFILL_GS = `
UPDATE \`target_websites\`
SET \`appKey\` = 'google-sheets'
WHERE \`templateType\` = 'google-sheets'
  AND (\`appKey\` IS NULL OR \`appKey\` = '')
`;

async function main() {
  const url = pickMysqlUrl();
  if (!url) {
    console.error(JSON.stringify({ ok: false, error: "No mysql:// URL" }));
    process.exit(2);
  }

  const conn = await mysql.createConnection(url);

  const [beforeApps] = await conn.query(
    "SELECT appKey, displayName, isActive FROM apps WHERE appKey IN ('telegram','google-sheets') ORDER BY appKey",
  );
  const [beforeActions] = await conn.query(
    "SELECT appKey, actionKey, name FROM app_actions WHERE appKey IN ('telegram','google-sheets') ORDER BY appKey, actionKey",
  );

  await conn.query(UPSERT_APPS);
  await conn.query(UPSERT_ACTIONS);

  const [twR] = await conn.query(BACKFILL_TW);
  const [gsR] = await conn.query(BACKFILL_GS);
  const twChanged = typeof twR === "object" && twR !== null && "affectedRows" in twR ? twR.affectedRows : 0;
  const gsChanged = typeof gsR === "object" && gsR !== null && "affectedRows" in gsR ? gsR.affectedRows : 0;

  const [afterApps] = await conn.query(
    "SELECT appKey, displayName, isActive FROM apps WHERE appKey IN ('telegram','google-sheets') ORDER BY appKey",
  );
  const [afterActions] = await conn.query(
    "SELECT appKey, actionKey, name FROM app_actions WHERE appKey IN ('telegram','google-sheets') ORDER BY appKey, actionKey",
  );

  const [tgCount] = await conn.query(
    "SELECT COUNT(*) AS c FROM apps WHERE appKey = 'telegram'",
  );
  const [gsCount] = await conn.query(
    "SELECT COUNT(*) AS c FROM apps WHERE appKey = 'google-sheets'",
  );

  await conn.end();

  const cTele = Number(tgCount[0]?.c ?? 0);
  const cGS = Number(gsCount[0]?.c ?? 0);

  const out = {
    ok: true,
    before: { apps: beforeApps, appActions: beforeActions },
    after: { apps: afterApps, appActions: afterActions },
    targetWebsitesBackfill: { telegramRowsUpdated: twChanged, googleSheetsRowsUpdated: gsChanged },
    counts: { telegram: cTele, "google-sheets": cGS },
  };

  console.log(JSON.stringify(out, null, 2));

  if (cTele !== 1 || cGS !== 1) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

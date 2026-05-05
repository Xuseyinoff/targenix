/**
 * Create app_actions table if missing.
 * Usage: railway run node tooling/mysql/create-app-actions.mjs
 */
import mysql from "mysql2/promise";

function getMysqlUrl() {
  for (const raw of [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL, process.env.DATABASE_URL]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

async function main() {
  const url = getMysqlUrl();
  if (!url) { console.error("No mysql:// URL found"); process.exit(1); }

  const cn = await mysql.createConnection(url);
  try {
    await cn.query(`
      CREATE TABLE IF NOT EXISTS app_actions (
        id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        appKey          VARCHAR(64)  NOT NULL,
        actionKey       VARCHAR(64)  NOT NULL DEFAULT 'default',
        name            VARCHAR(255) NOT NULL,
        endpointUrl     VARCHAR(500) NOT NULL,
        method          VARCHAR(10)  NOT NULL DEFAULT 'POST',
        contentType     VARCHAR(100) NULL,
        bodyFields      JSON         NOT NULL,
        userFields      JSON         NOT NULL,
        variableFields  JSON         NOT NULL,
        autoMappedFields JSON        NOT NULL,
        schemaVersion   INT          NOT NULL DEFAULT 1,
        inputSchema     JSON         NULL,
        outputSchema    JSON         NULL,
        uiSchema        JSON         NULL,
        isDefault       TINYINT(1)   NOT NULL DEFAULT 1,
        isActive        TINYINT(1)   NOT NULL DEFAULT 1,
        createdAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uniq_app_action (appKey, actionKey),
        INDEX idx_app_actions_appKey (appKey)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log("✓ app_actions table ready");
  } finally {
    await cn.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * Stage 1 — pre/post checks for `apps` + `app_actions` mirror tables (0048).
 *
 * Read-only when run with: audit
 * After migration, run: verify
 *
 *   node tooling/mysql/stage1-apps-mirror-preflight.mjs audit
 *   node tooling/mysql/stage1-apps-mirror-preflight.mjs verify
 */

import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
}

async function audit(conn) {
  const [[{ n: specs }]] = await conn.query("SELECT COUNT(*) AS n FROM connection_app_specs");
  const [[{ n: tpl }]] = await conn.query("SELECT COUNT(*) AS n FROM destination_templates");
  const [[{ nullKeySpecs }]] = await conn.query(
    "SELECT COUNT(*) AS nullKeySpecs FROM connection_app_specs WHERE appKey IS NULL OR TRIM(appKey) = ''",
  );
  const [[{ nullNameTpl }]] = await conn.query(
    "SELECT COUNT(*) AS nullNameTpl FROM destination_templates WHERE name IS NULL OR TRIM(name) = ''",
  );
  const [[{ nullUrlTpl }]] = await conn.query(
    "SELECT COUNT(*) AS nullUrlTpl FROM destination_templates WHERE endpointUrl IS NULL OR TRIM(endpointUrl) = ''",
  );
  const [[{ nullAppKeyTpl }]] = await conn.query(
    "SELECT COUNT(*) AS nullAppKeyTpl FROM destination_templates WHERE appKey IS NULL OR TRIM(appKey) = ''",
  );
  console.log(
    JSON.stringify(
      {
        step: "audit",
        connection_app_specs_rows: Number(specs),
        destination_templates_rows: Number(tpl),
        anomalies: {
          connection_app_specs_bad_appKey: Number(nullKeySpecs),
          destination_templates_bad_name: Number(nullNameTpl),
          destination_templates_bad_endpointUrl: Number(nullUrlTpl),
          destination_templates_missing_appKey: Number(nullAppKeyTpl),
        },
        safeToRun0048:
          Number(nullKeySpecs) !== 0
            ? "NO — bad appKey in connection_app_specs"
            : Number(nullNameTpl) !== 0 || Number(nullUrlTpl) !== 0
              ? "NO — fix NULL/empty name or endpointUrl in destination_templates"
              : Number(nullAppKeyTpl) > 0
                ? "YES — app_actions copy skips rows without appKey; counts will be templates_total − missing_appKey"
                : "YES",
      },
      null,
      2,
    ),
  );
}

async function verify(conn) {
  const [[{ apps }]] = await conn.query(
    "SELECT COUNT(*) AS apps FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'apps'",
  );
  const [[{ actions }]] = await conn.query(
    "SELECT COUNT(*) AS actions FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'app_actions'",
  );
  if (!Number(apps) || !Number(actions)) {
    console.log(JSON.stringify({ step: "verify", error: "apps or app_actions table missing — run migration 0048" }, null, 2));
    return;
  }

  const [[{ n: nApps }]] = await conn.query("SELECT COUNT(*) AS n FROM apps");
  const [[{ n: nSpecs }]] = await conn.query("SELECT COUNT(*) AS n FROM connection_app_specs");
  const [[{ n: nAct }]] = await conn.query("SELECT COUNT(*) AS n FROM app_actions");
  const [[{ n: nTpl }]] = await conn.query("SELECT COUNT(*) AS n FROM destination_templates");
  const [[{ n: nTplKeyed }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM destination_templates WHERE appKey IS NOT NULL AND appKey <> ''",
  );
  const [[{ n: nullApps }]] = await conn.query("SELECT COUNT(*) AS n FROM apps WHERE appKey IS NULL OR TRIM(appKey) = ''");
  const [[{ n: nullAct }]] = await conn.query("SELECT COUNT(*) AS n FROM app_actions WHERE appKey IS NULL OR TRIM(appKey) = ''");

  console.log(
    JSON.stringify(
      {
        step: "verify",
        counts: {
          apps: Number(nApps),
          connection_app_specs: Number(nSpecs),
          apps_match_specs: Number(nApps) === Number(nSpecs),
          app_actions: Number(nAct),
          destination_templates: Number(nTpl),
          destination_templates_with_appKey: Number(nTplKeyed),
          app_actions_match_keyed_templates: Number(nAct) === Number(nTplKeyed),
        },
        null_guard: {
          apps_rows_with_null_appKey: Number(nullApps),
          app_actions_rows_with_null_appKey: Number(nullAct),
        },
        safe:
          Number(nApps) === Number(nSpecs) &&
          Number(nAct) === Number(nTplKeyed) &&
          Number(nullApps) === 0 &&
          Number(nullAct) === 0,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const cmd = process.argv[2] || "audit";
  const url = getMysqlUrl();
  if (!url) {
    console.error("No DATABASE_URL / MYSQL_URL");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    if (cmd === "verify") await verify(conn);
    else await audit(conn);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
